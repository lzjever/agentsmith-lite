export type SandboxUsageAnchorActivationState = {
  activated: boolean;
};

export function decideSandboxUsageAnchorActivation(
  state: SandboxUsageAnchorActivationState,
  input: {
    hash: string;
    overviewLoaded: boolean;
  }
): {
  state: SandboxUsageAnchorActivationState;
  activate: boolean;
} {
  if (
    state.activated
    || !input.overviewLoaded
    || input.hash !== "#sandbox-usage"
  ) {
    return { state, activate: false };
  }
  return {
    state: { activated: true },
    activate: true
  };
}
