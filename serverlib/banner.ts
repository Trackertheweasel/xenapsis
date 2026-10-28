import chalk from 'chalk';
import { version } from '../package.json' with { type: 'json' };
import type { AccessConfig } from './access';

export function printBanner(port: number, access: AccessConfig | null) {
  // The two hosts the README supports; anywhere else the local address is shown.
  const deploymentURL =
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.CODESPACES &&
      `https://${process.env.CODESPACE_NAME}-${port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`);

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
    chalk.hex('#bdc3c7')('   └─ ') +
      chalk.hex('#ecf0f1')('Version: ') +
      chalk.hex('#f39c12')(`v${version}`),
  );
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
