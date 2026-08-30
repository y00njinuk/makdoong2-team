// Cross-call stall escalation for dispatch_stage.
//
// Lives in its own module rather than opencode-plugin.ts because opencode's
// plugin loader invokes EVERY named export of the plugin entry file as a
// plugin factory (see test/plugin-exports-shape.test.ts and the PROJ-40406
// root-cause analysis). Helpers must therefore be imported, never re-exported
// from the entry file.

// dispatch_stage bounds retries with MAX_ATTEMPTS, but that budget lives
// inside a single tool call. When the orchestrator reacts to a failure by
// calling dispatch_stage again the budget resets, so a substage whose model
// keeps hanging loops forever. hang_history is the only counter that survives
// across calls, which makes it the escalation signal.
//
// hangCount comes from `state.sh get … | length`, so an unreadable or corrupt
// state.json yields NaN. Treating NaN as "escalate" would deadlock every
// workflow that cannot read its state file, so unreadable input fails open —
// blocking happens only on a value we actually trust.
export function shouldEscalateStall(hangCount: number, threshold: number): boolean {
  if (!Number.isFinite(hangCount) || !Number.isFinite(threshold)) return false;
  return hangCount >= threshold;
}
