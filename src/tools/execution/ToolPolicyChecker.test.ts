import test from 'node:test';
import assert from 'node:assert/strict';

import { DefaultToolPolicyChecker, type IToolPolicyChecker } from './ToolPolicyChecker.js';

test('DefaultToolPolicyChecker always allows', () => {
  const checker: IToolPolicyChecker = new DefaultToolPolicyChecker();
  const result = checker.checkPolicy('any_tool', 'search', {}, {
    conversationId: 'c1',
    signal: new AbortController().signal,
    policyConfig: {},
  });
  assert.equal(result.allowed, true);
});
