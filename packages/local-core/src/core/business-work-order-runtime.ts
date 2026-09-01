import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import businessModule from '@orquesta/business-orchestrator';
import eventStoreModule from '@orquesta/event-store';
import { PROJECT_STORAGE, projectStoragePath } from './project-storage-layout';
import type { BusinessWorkOrdersReadRequest } from './protocol';

type JsonRecord = Record<string, unknown>;

const { createEventStore } = eventStoreModule as {
  createEventStore(options: JsonRecord): {
    replay(options: JsonRecord): {
      state: JsonRecord;
      cursor: JsonRecord;
      continuity: string;
    };
  };
};
const {
  businessProjectionConfigurationV1,
  createBusinessDesktopReadResultV1,
} = businessModule as {
  businessProjectionConfigurationV1(): { reducers: JsonRecord; initialState: JsonRecord };
  createBusinessDesktopReadResultV1(input: JsonRecord): JsonRecord;
};

interface RootIdentity {
  canonicalRoot: string;
  device: number;
  inode: number;
}

async function inspectRoot(rootPath: string): Promise<RootIdentity> {
  const canonicalRoot = await realpath(path.resolve(rootPath));
  for (const part of ['.orquesta', path.join('.orquesta', PROJECT_STORAGE.businessStore)]) {
    const metadata = await lstat(path.join(canonicalRoot, part));
    if (metadata.isSymbolicLink()) throw Object.assign(new Error('Business source crosses a symbolic link'), {
      code: 'BUSINESS_DESKTOP_SOURCE_UNSAFE',
    });
  }
  const metadata = await stat(canonicalRoot);
  return { canonicalRoot, device: metadata.dev, inode: metadata.ino };
}

function sameRoot(left: RootIdentity, right: RootIdentity): boolean {
  return left.canonicalRoot === right.canonicalRoot
    && left.device === right.device
    && left.inode === right.inode;
}

export async function readBusinessWorkOrders(input: {
  request: BusinessWorkOrdersReadRequest;
  runtimeProjectId: string;
  rootPath: string;
}): Promise<JsonRecord> {
  const before = await inspectRoot(input.rootPath);
  const configuration = businessProjectionConfigurationV1();
  const store = createEventStore({
    stateRoot: projectStoragePath(before.canonicalRoot, PROJECT_STORAGE.businessStore),
    workspaceId: input.runtimeProjectId,
  });
  const replayed = store.replay({
    reducers: configuration.reducers,
    initialState: configuration.initialState,
    claimedEventPrefixes: ['business.'],
    afterCursor: input.request.afterCursor ?? null,
  });
  const after = await inspectRoot(input.rootPath);
  if (!sameRoot(before, after)) {
    throw Object.assign(new Error('The selected project changed while Business state was being read'), {
      code: 'BUSINESS_DESKTOP_SOURCE_RECOVERY_REQUIRED',
      details: { reason: 'root_identity_changed' },
    });
  }
  return createBusinessDesktopReadResultV1({
    request: input.request,
    projection: replayed.state,
    cursor: replayed.cursor,
    continuity: replayed.continuity,
    runtimeProjectId: input.runtimeProjectId,
  });
}
