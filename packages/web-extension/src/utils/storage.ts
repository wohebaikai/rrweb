import { openDB } from 'idb';
import type { eventWithTime } from '@rrweb/types';
import type { Session } from '~/types';
import type { SummaryResult } from '~/utils/summarize';

/**
 * Storage related functions with indexedDB.
 */

const EventStoreName = 'events';
type EventData = {
  id: string;
  events: eventWithTime[];
};

const SummaryStoreName = 'summaries';

/**
 * Bump this when the summarization algorithm / prompt changes in a way that
 * invalidates previously cached summaries. Stored summaries whose `schemaVersion`
 * is older than this will be ignored and regenerated on next open.
 */
export const SUMMARY_SCHEMA_VERSION = 3;

export type StoredSummary = {
  id: string;
  /** When the summary was generated (ms epoch) */
  generatedAt: number;
  /** Algorithm/prompt version that produced this summary */
  schemaVersion: number;
  /** LLM settings snapshot used to produce this summary */
  llmSnapshot: {
    enabled: boolean;
    endpoint: string;
    model: string;
  };
  result: SummaryResult;
};

export async function getSummaryStore() {
  return openDB<StoredSummary>(SummaryStoreName, 1, {
    upgrade(db) {
      db.createObjectStore(SummaryStoreName, {
        keyPath: 'id',
        autoIncrement: false,
      });
    },
  });
}

export async function getSummary(id: string) {
  const db = await getSummaryStore();
  return (await db.get(SummaryStoreName, id)) as StoredSummary | undefined;
}

export async function saveSummary(
  id: string,
  result: SummaryResult,
  llmSnapshot: StoredSummary['llmSnapshot'],
) {
  const db = await getSummaryStore();
  const stored: StoredSummary = {
    id,
    generatedAt: Date.now(),
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    llmSnapshot,
    result,
  };
  await db.put(SummaryStoreName, stored);
  return stored;
}

export async function deleteSummary(id: string) {
  const db = await getSummaryStore();
  await db.delete(SummaryStoreName, id);
}

export async function getEventStore() {
  return openDB<EventData>(EventStoreName, 1, {
    upgrade(db) {
      db.createObjectStore(EventStoreName, {
        keyPath: 'id',
        autoIncrement: false,
      });
    },
  });
}

export async function getEvents(id: string) {
  const db = await getEventStore();
  const data = (await db.get(EventStoreName, id)) as EventData;
  return data.events;
}

const SessionStoreName = 'sessions';
export async function getSessionStore() {
  return openDB<Session>(SessionStoreName, 1, {
    upgrade(db) {
      // Create a store of objects
      db.createObjectStore(SessionStoreName, {
        // The 'id' property of the object will be the key.
        keyPath: 'id',
        // If it isn't explicitly set, create a value by auto incrementing.
        autoIncrement: false,
      });
    },
  });
}

export async function addSession(session: Session, events: eventWithTime[]) {
  const eventStore = await getEventStore();
  await eventStore.put(EventStoreName, { id: session.id, events });
  const store = await getSessionStore();
  await store.add(SessionStoreName, session);
}

export async function updateSession(
  session: Session,
  events?: eventWithTime[],
) {
  const eventStore = await getEventStore();
  if (events) {
    await eventStore.put(EventStoreName, { id: session.id, events });
  }
  const store = await getSessionStore();
  await store.put(SessionStoreName, session);
}

export async function getSession(id: string) {
  const store = await getSessionStore();
  return store.get(SessionStoreName, id) as Promise<Session>;
}

export async function getAllSessions() {
  const store = await getSessionStore();
  const sessions = (await store.getAll(SessionStoreName)) as Session[];
  return sessions.sort((a, b) => b.createTimestamp - a.createTimestamp);
}

export async function deleteSession(id: string) {
  const eventStore = await getEventStore();
  const sessionStore = await getSessionStore();
  await Promise.all([
    eventStore.delete(EventStoreName, id),
    sessionStore.delete(SessionStoreName, id),
    deleteSummary(id),
  ]);
}

export async function deleteSessions(ids: string[]) {
  const eventStore = await getEventStore();
  const sessionStore = await getSessionStore();
  const summaryStore = await getSummaryStore();
  const eventTransition = eventStore.transaction(EventStoreName, 'readwrite');
  const sessionTransition = sessionStore.transaction(
    SessionStoreName,
    'readwrite',
  );
  const summaryTransition = summaryStore.transaction(
    SummaryStoreName,
    'readwrite',
  );
  const promises = [];
  for (const id of ids) {
    promises.push(eventTransition.store.delete(id));
    promises.push(sessionTransition.store.delete(id));
    promises.push(summaryTransition.store.delete(id));
  }
  await Promise.all(promises).then(() => {
    return Promise.all([
      eventTransition.done,
      sessionTransition.done,
      summaryTransition.done,
    ]);
  });
}

export async function downloadSessions(ids: string[]) {
  for (const sessionId of ids) {
    const events = await getEvents(sessionId);
    const session = await getSession(sessionId);
    const blob = new Blob([JSON.stringify({ session, events }, null, 2)], {
      type: 'application/json',
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session.name}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
