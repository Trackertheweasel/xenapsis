// Version history shown in Settings → About. Every pull request that changes what Persec does adds
// one line to the newest entry (or a new entry, with package.json's version bumped to match).
// tests/changelog.test.ts checks the newest entry is package.json's version.

export interface Change {
  pr: number;
  title: string;
}

export interface Release {
  version: string;
  date: string; // YYYY-MM-DD
  changes: Change[];
}

export const CHANGELOG: Release[] = [
  {
    version: '2.5.0',
    date: '2026-10-29',
    changes: [
      { pr: 61, title: 'Admin page: invite list, create and revoke invites, server setup check' },
      {
        pr: 60,
        title:
          "Custom tiles, themes, privacy guards, tunnel ad blocking, and Interstellar's games and apps",
      },
      { pr: 59, title: 'Proxy names scrubbed from the build, and opt-in text masking' },
      { pr: 58, title: 'WebRTC no longer leaks real IPs, and sign-in pop-ups open' },
      { pr: 57, title: "Fixes for the bug audit's high and medium findings" },
      { pr: 56, title: 'Web AI presets for ChatGPT and Claude, and an optional browser mode' },
      {
        pr: 55,
        title:
          "PerSec AI: free models by default, per-visitor open-mode limit, refused requests don't count",
      },
      { pr: 54, title: 'PerSec AI, a chat assistant powered by OpenRouter' },
      { pr: 53, title: 'Client code restructured, and ads moved into the server' },
      { pr: 52, title: 'Smaller, observable and reversible deploys' },
      { pr: 51, title: "Fixes for the security audit's high and medium findings" },
    ],
  },
];
