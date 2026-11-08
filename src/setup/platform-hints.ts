export type Platform = NodeJS.Platform;

export interface PermissionAdvice {
  fixHint: string | null;
  fixHintFollowUp: string | null;
  offerSudo: boolean;
  failMessage: string;
}

export function permissionAdvice(platform: Platform): PermissionAdvice {
  if (platform === "win32") {
    return {
      fixHint: null,
      fixHintFollowUp: null,
      offerSudo: false,
      failMessage:
        "tailscale cert needs elevated access. Re-run this wizard from an elevated " +
        "(Administrator) prompt.",
    };
  }
  const fix = `sudo tailscale set --operator=$(whoami)`;
  return {
    fixHint: `Fix this permanently: ${fix}`,
    fixHintFollowUp:
      "Future tailscale commands, including re-runs of this wizard, won't need sudo after that.",
    offerSudo: true,
    failMessage: `Run \`${fix}\`, then re-run this wizard.`,
  };
}

export function confWrittenNote(platform: Platform, path: string): string {
  if (platform === "win32") {
    return `Wrote ${path} (stored in your user profile; Windows file modes are not applied)`;
  }
  return `Wrote ${path} (chmod 600)`;
}

export function certChmodWarning(platform: Platform, message: string): string | null {
  if (platform === "win32") {
    return null;
  }
  return `Couldn't chmod cert files (${message}). Check ownership if HTTPS fails to start.`;
}

export function confHeader(platform: Platform): string {
  const lock =
    platform === "win32"
      ? "# Stored in your user profile; Windows file modes are not applied."
      : "# Lock this file: chmod 600.";
  return `# hydra-acp-browser config \u2014 written by 'hydra-acp-browser tailscale setup'.\n${lock}\n`;
}
