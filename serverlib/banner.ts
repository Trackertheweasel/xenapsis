import chalk from 'chalk';
import { version } from '../package.json' with { type: 'json' };
import type { AccessConfig } from './access';
import { updateChecker } from './check';
import { findProvider } from './provider';

export function printBanner(port: number, access: AccessConfig | null) {
  const updateStatus = updateChecker();
  type StatusKey = 'u' | 'n' | 'f';
  const statusMap: Record<
    StatusKey,
    { icon: string; text: string; color: string; extra?: string }
  > = {
    u: { icon: '✅', text: 'Up to date', color: '#2ecc71' },
    n: {
      icon: '❌',
      text: `Update available (${updateStatus.commitId})`,
      color: '#f1c40f',
      extra: chalk.hex('#95a5a6')('→ https://github.com/Trackertheweasel/xenapsis'),
    },
    f: { icon: '❌', text: 'Failed to check for updates', color: '#e74c3c' },
  };
  const statusKey = (
    ['u', 'n', 'f'].includes(updateStatus.status) ? updateStatus.status : 'f'
  ) as StatusKey;
  const status = statusMap[statusKey];
  const deploymentURL = findProvider(port);

  console.log();
  console.log(chalk.hex('#8e44ad').bold('╭────────────────────────────────────────────╮'));
  console.log(
    chalk.hex('#8e44ad').bold('│ ') +
      chalk.hex('#f39c12').bold('🔒 Persec Server Started') +
      '                  │',
  );
  console.log(chalk.hex('#8e44ad').bold('╰────────────────────────────────────────────╯'));
  console.log();
  console.log(chalk.hex('#00cec9')('Information:'));
  console.log(
    chalk.hex('#bdc3c7')('   ├─ ') +
      chalk.hex('#ecf0f1')('Version: ') +
      chalk.hex('#f39c12')(`v${version}`),
  );
  console.log(
    chalk.hex('#bdc3c7')('   └─ ') +
      chalk.hex('#ecf0f1')('Up to date: ') +
      chalk.hex(status.color)(`${status.icon} ${status.text}`),
  );
  if (status.extra) console.log('       ' + status.extra);
  console.log();
  console.log(
    chalk.hex('#bdc3c7')('   Access: ') +
      chalk.hex('#ecf0f1')(
        access
          ? `invite-only (${access.codes.size} code${access.codes.size === 1 ? '' : 's'}${access.minted ? ', minted invites on' : ''})`
          : 'open to everyone',
      ),
  );
  if (access && !access.minted) {
    console.log(
      chalk.hex('#f1c40f')('   Set PERSEC_SECRET so people stay signed in across restarts.'),
    );
    if (!access.codes.size) {
      console.log(
        chalk.hex('#e74c3c')('   No invite codes and no PERSEC_SECRET: nobody can sign in.'),
      );
    }
  }
  console.log();
  console.log(chalk.hex('#00b894')('Access Information:'));
  if (deploymentURL) {
    console.log(
      chalk.hex('#bdc3c7')('   ├─ ') +
        chalk.hex('#ecf0f1')('Deployment URL: ') +
        chalk.hex('#0984e3').underline(deploymentURL),
    );
    console.log(
      chalk.hex('#bdc3c7')('   └─ ') +
        chalk.hex('#ecf0f1')('Hosting Method: ') +
        chalk.hex('#95a5a6')('Cloud Hosting'),
    );
  } else {
    console.log(
      chalk.hex('#bdc3c7')('   ├─ ') +
        chalk.hex('#ecf0f1')('Local: ') +
        chalk.hex('#00cec9').underline(`http://localhost:${port}`),
    );
    console.log(
      chalk.hex('#bdc3c7')('   ├─ ') +
        chalk.hex('#ecf0f1')('Network: ') +
        chalk.hex('#00cec9').underline(`http://127.0.0.1:${port}`),
    );
    console.log(
      chalk.hex('#bdc3c7')('   └─ ') +
        chalk.hex('#ecf0f1')('Hosting Method: ') +
        chalk.hex('#95a5a6')('Self Hosting'),
    );
  }
  console.log();
  console.log(chalk.hex('#8e44ad').bold('──────────────────────────────────────────────'));
  console.log();
}
