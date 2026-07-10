/// <reference types="chrome"/>
import { useRef, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Replayer from 'rrweb-player';
import {
  Box,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  Button,
  Center,
  Flex,
} from '@chakra-ui/react';
import { FiList } from 'react-icons/fi';
import { getEvents, getSession } from '~/utils/storage';

export default function Player() {
  const playerElRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Replayer | null>(null);
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [sessionName, setSessionName] = useState('');

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    getSession(sessionId)
      .then((session) => {
        if (cancelled) return;
        setSessionName(session.name);
      })
      .catch((err) => {
        console.error(err);
      });
    getEvents(sessionId)
      .then((events) => {
        if (cancelled) return;
        if (!playerElRef.current) return;
        if (playerRef.current) return;

        const manifest = chrome.runtime.getManifest();
        const rrwebPlayerVersion = manifest.version_name || manifest.version;
        const linkEl = document.createElement('link');
        linkEl.href = `https://cdn.jsdelivr.net/npm/rrweb-player@${rrwebPlayerVersion}/dist/style.min.css`;
        linkEl.rel = 'stylesheet';
        document.head.appendChild(linkEl);
        playerRef.current = new Replayer({
          target: playerElRef.current as HTMLElement,
          props: {
            events,
            autoPlay: true,
          },
        });
      })
      .catch((err) => {
        console.error(err);
      });
    return () => {
      cancelled = true;
      const player = playerRef.current;
      playerRef.current = null;
      if (player) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (player as any).pause?.();
        } catch {
          /* ignore — player may not be fully initialized */
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (player as any).$destroy?.();
        } catch {
          /* ignore */
        }
      }
    };
  }, [sessionId]);

  return (
    <>
      <Flex justify="space-between" align="center" mb={5}>
        <Breadcrumb fontSize="md">
          <BreadcrumbItem>
            <BreadcrumbLink href="#">Sessions</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbItem>
            <BreadcrumbLink>{sessionName}</BreadcrumbLink>
          </BreadcrumbItem>
        </Breadcrumb>
        <Button
          leftIcon={<FiList />}
          size="sm"
          onClick={() => navigate(`/summary/${sessionId}`)}
        >
          操作步骤总结
        </Button>
      </Flex>
      <Center>
        <Box ref={playerElRef}></Box>
      </Center>
    </>
  );
}
