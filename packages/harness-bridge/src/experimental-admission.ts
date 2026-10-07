/** Reviewed against the fixed rc.2 public package APIs. Neither flag authorizes execution.
 * Keep unsupported native inference out of the tool catalog until its request caps and
 * canonical UsageRecord/CostRecord settlement can be enforced by the Host. */
export const HARNESS_EXPERIMENTAL_ADMISSION = Object.freeze({
  team: Object.freeze({ enabled: false, backend: 'official-team', reason: 'team-product-authority-and-qualification-required', recoveryAdapter: 'available' }),
  stagehand: Object.freeze({ enabled: false, backend: 'stagehand-native', reason: 'stagehand-inference-accounting-unavailable' }),
});
