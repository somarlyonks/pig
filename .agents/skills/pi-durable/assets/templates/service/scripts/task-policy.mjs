#!/usr/bin/env node
// Pure synthetic task policy for the optional evolution demonstration.
// This function is not wired into GitHub admission or the production service.
export function decideTask(event) {
  if (event.seen || event.draft) return 'ignore';
  return event.kind === 'pull_request' && event.action === 'opened' ? 'review' : 'ignore';
}
