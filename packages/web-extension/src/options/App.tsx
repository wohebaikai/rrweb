import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import SidebarWithHeader from '~/components/SidebarWithHeader';
import { FiList, FiSettings } from 'react-icons/fi';
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  Input,
  Stack,
  Switch,
  Text,
  useToast,
} from '@chakra-ui/react';
import type { LLMSettings } from '~/types';
import {
  DEFAULT_LLM_SETTINGS,
  getLLMSettings,
  setLLMSettings,
} from '~/utils/llmSettings';

export default function App() {
  return (
    <SidebarWithHeader
      title="Settings"
      headBarItems={[
        {
          label: 'Sessions',
          icon: FiList,
          href: '/pages/index.html#',
        },
        {
          label: 'Settings',
          icon: FiSettings,
          href: '#',
        },
      ]}
      sideBarItems={[]}
    >
      <Box p="10">
        <Routes>
          <Route path="/" element={<LLMSettingsForm />} />
        </Routes>
      </Box>
    </SidebarWithHeader>
  );
}

function LLMSettingsForm() {
  const [settings, setSettings] = useState<LLMSettings>(DEFAULT_LLM_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void getLLMSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await setLLMSettings(settings);
      toast({
        title: '设置已保存',
        status: 'success',
        duration: 2000,
        isClosable: true,
      });
    } catch (e) {
      toast({
        title: '保存失败',
        description: (e as Error).message,
        status: 'error',
        duration: 3000,
        isClosable: true,
      });
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  return (
    <Stack spacing={6} maxW="container.md">
      <Box>
        <Heading size="md" mb={2}>
          大模型（LLM）设置
        </Heading>
        <Text color="gray.500" fontSize="sm">
          用于在「操作步骤总结」页面将录制事件总结为中文描述。支持任意 OpenAI
          兼容的 Chat Completions 接口。
        </Text>
      </Box>

      <Alert status="info">
        <AlertIcon />
        未启用 LLM 时，总结页面将仅使用规则匹配生成中文步骤描述。
      </Alert>

      <FormControl>
        <FormLabel>启用 LLM 总结</FormLabel>
        <Switch
          isChecked={settings.enabled}
          onChange={(e) =>
            setSettings({ ...settings, enabled: e.target.checked })
          }
        />
        <FormHelperText>
          开启后将调用下方配置的 LLM 接口优化每步描述并生成总体总结。
        </FormHelperText>
      </FormControl>

      <FormControl isRequired>
        <FormLabel>API Endpoint</FormLabel>
        <Input
          value={settings.endpoint}
          onChange={(e) =>
            setSettings({ ...settings, endpoint: e.target.value })
          }
          placeholder="https://api.openai.com/v1/chat/completions"
        />
        <FormHelperText>
          OpenAI 兼容的 Chat Completions 接口地址。
        </FormHelperText>
      </FormControl>

      <FormControl isRequired>
        <FormLabel>API Key</FormLabel>
        <Input
          type="password"
          value={settings.apiKey}
          onChange={(e) =>
            setSettings({ ...settings, apiKey: e.target.value })
          }
          placeholder="sk-..."
        />
        <FormHelperText>仅保存在本地浏览器 storage 中。</FormHelperText>
      </FormControl>

      <FormControl isRequired>
        <FormLabel>模型名称</FormLabel>
        <Input
          value={settings.model}
          onChange={(e) =>
            setSettings({ ...settings, model: e.target.value })
          }
          placeholder="gpt-4o-mini"
        />
        <FormHelperText>
          例如：gpt-4o-mini、gpt-4o、deepseek-chat 等。
        </FormHelperText>
      </FormControl>

      <Box>
        <Button
          colorScheme="blue"
          onClick={() => void handleSave()}
          isLoading={saving}
          isDisabled={saving}
        >
          保存设置
        </Button>
      </Box>
    </Stack>
  );
}
