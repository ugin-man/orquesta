import { test } from 'vitest';

import { verifyTargetIgnoresMalformedSiblings } from '../test-support/message-ledger-v2-scale';

test('reads and advances one target among 10000 malformed siblings', async () => {
  await verifyTargetIgnoresMalformedSiblings(10_000);
}, 30_000);
