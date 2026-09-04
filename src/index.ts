#!/usr/bin/env node

/**
 * Chrome DevTools CLI
 * Command-line interface for Chrome DevTools Protocol
 * Optimized for LLM agents with NDJSON output
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'node:fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { CDPContext, setDefaultWorkspaceSession } from './context.js';
import { versionString } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
import * as pages from './commands/pages.js';
import * as debug from './commands/debug.js';
import * as network from './commands/network.js';
import {
  LIST_CONSOLE_DESCRIPTION,
  LIST_NETWORK_DESCRIPTION
} from './commands/stream-monitor.js';
import * as input from './commands/input.js';
import * as daemon from './commands/daemon.js';
import * as logs from './commands/logs.js';
import * as lifecycle from './commands/lifecycle.js';
import * as doctor from './commands/doctor.js';
import * as diagnose from './commands/diagnose.js';
import * as targets from './commands/targets.js';
import { waitForPageConditions } from './commands/wait.js';
import { outputError, outputLines, outputSuccess } from './output.js';
import { homedir } from 'os';
import { describeCliPath } from './path.js';
import {
  WorkspaceSessionService,
  defaultWorkspaceSessionStorePath
} from './sessions/workspace-session-service.js';
import { SessionFoundationError } from './sessions/errors.js';
import { DaemonClient } from './daemon/client.js';
import { SessionStore } from './sessions/session-store.js';
import { coordinateWorkspaceSessionDisposal } from './sessions/session-disposal-coordinator.js';
import {
  validateNavigateParams,
  validateEvalParams,
  validateLogsParams,
  validatePressKeyParams,
  validateFillParams,
  validateLogsDetailParams,
  buildErrorWithHint
} from './validation.js';

const DEFAULT_CDP_URL = process.env.CDP_URL?.trim() || 'http://localhost:9222';

/** Options shared by commands that can trigger page work and then wait. */
function addAdvancedWaitOptions(yargs: any): any {
  return yargs
    .option('wait-for-expression', {
      type: 'string',
      description: 'Wait until this JavaScript expression resolves truthy'
    })
    .option('wait-for-expression-file', {
      type: 'string',
      description: 'Read the JavaScript wait expression from this file'
    })
    .option('wait-for-expression-stdin', {
      type: 'boolean',
      description: 'Read the JavaScript wait expression from standard input',
      default: false
    })
    .option('wait-for-response', {
      type: 'string',
      description: 'Wait for a response whose URL contains this literal substring'
    })
    .option('wait-for-status', {
      type: 'number',
      description: 'With --wait-for-response, require this HTTP status'
    })
    .option('wait-for-body-text', {
      type: 'string',
      description: 'With --wait-for-response, require literal text in the first 64 KiB of the body (never printed)'
    });
}

function waitOptionsFromArgv(argv: Record<string, unknown>) {
  const waitForExpression = expressionFromArgv(
    argv,
    'wait-for-expression',
    'wait-for-expression-file',
    'wait-for-expression-stdin'
  );

  const waitForResponse = stringOption(argv, 'wait-for-response');
  const waitForStatus = numberOption(argv, 'wait-for-status');
  const waitForBodyText = stringOption(argv, 'wait-for-body-text');
  if ((waitForStatus !== undefined || waitForBodyText !== undefined) && !waitForResponse) {
    throw new Error('--wait-for-status and --wait-for-body-text require --wait-for-response');
  }
  if (waitForStatus !== undefined && (!Number.isInteger(waitForStatus) || waitForStatus < 100 || waitForStatus > 599)) {
    throw new Error('--wait-for-status must be an HTTP status from 100 through 599');
  }

  return {
    waitFor: stringOption(argv, 'wait-for'),
    waitForText: stringOption(argv, 'wait-for-text'),
    waitForExpression,
    waitForResponse,
    waitForStatus,
    waitForBodyText,
    waitForIdle: booleanOption(argv, 'wait-for-idle'),
    waitForFrame: stringOption(argv, 'wait-for-frame'),
    waitForNavigation: booleanOption(argv, 'wait-for-navigation'),
    timeout: numberOption(argv, 'timeout')
  };
}

function standaloneWaitOptionsFromArgv(argv: Record<string, unknown>) {
  const waitForExpression = expressionFromArgv(argv, 'expression', 'expression-file', 'expression-stdin');
  const waitForResponse = stringOption(argv, 'wait-for-response');
  const waitForStatus = numberOption(argv, 'wait-for-status');
  const waitForBodyText = stringOption(argv, 'wait-for-body-text');
  if ((waitForStatus !== undefined || waitForBodyText !== undefined) && !waitForResponse) {
    throw new Error('--wait-for-status and --wait-for-body-text require --wait-for-response');
  }
  if (waitForStatus !== undefined && (!Number.isInteger(waitForStatus) || waitForStatus < 100 || waitForStatus > 599)) {
    throw new Error('--wait-for-status must be an HTTP status from 100 through 599');
  }
  return {
    waitFor: stringOption(argv, 'wait-for'),
    waitForText: stringOption(argv, 'wait-for-text'),
    waitForExpression,
    waitForResponse,
    waitForStatus,
    waitForBodyText,
    waitForIdle: booleanOption(argv, 'wait-for-idle'),
    waitForFrame: stringOption(argv, 'wait-for-frame'),
    timeout: numberOption(argv, 'timeout')
  };
}

function expressionFromArgv(
  argv: Record<string, unknown>,
  inlineOption: string,
  fileOption: string,
  stdinOption: string
): string | undefined {
  const inline = stringOption(argv, inlineOption);
  const file = stringOption(argv, fileOption);
  const stdin = booleanOption(argv, stdinOption);
  const sources = Number(inline !== undefined) + Number(file !== undefined) + Number(stdin);
  if (sources > 1) {
    throw new Error(`Use only one of --${inlineOption}, --${fileOption}, or --${stdinOption}`);
  }

  let expression = inline;
  if (file !== undefined) {
    expression = readFileSync(describeCliPath(file).normalizedPath, 'utf8');
  } else if (stdin) {
    expression = readFileSync(0, 'utf8');
  }
  if (expression !== undefined && expression.trim().length === 0) {
    throw new Error('The wait expression must not be empty');
  }
  return expression;
}

function stringOption(argv: Record<string, unknown>, name: string): string | undefined {
  const value = argv[name] ?? argv[name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === 'string' ? value : undefined;
}

function numberOption(argv: Record<string, unknown>, name: string): number | undefined {
  const value = argv[name] ?? argv[name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanOption(argv: Record<string, unknown>, name: string): boolean | undefined {
  const value = argv[name] ?? argv[name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === 'boolean' ? value : undefined;
}

function outputThrownError(error: unknown, fallbackCode: string, details?: Record<string, unknown>): void {
  if (error instanceof SessionFoundationError) {
    outputError(error.message, error.code, { ...error.details, ...details });
    return;
  }
  outputError(error instanceof Error ? error.message : String(error), fallbackCode, details);
}

// Global error handler for unhandled exceptions
process.on('uncaughtException', (error) => {
  outputThrownError(error, 'UNCAUGHT_EXCEPTION', { stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  outputThrownError(reason, 'UNHANDLED_REJECTION', { stack });
  process.exit(1);
});

// Create CLI
const cli = yargs(hideBin(process.argv))
  .scriptName('cdp-cli')
  .version(versionString)
  .usage('Usage: $0 <command> [options]')
  .option('cdp-url', {
    type: 'string',
    description: 'Chrome DevTools Protocol URL',
    default: DEFAULT_CDP_URL
  })
  .option('session', {
    type: 'string',
    description: 'Named workspace session; page and target references must be exact owned IDs',
    default: process.env.CDP_SESSION?.trim() || undefined
  })
  .middleware((argv) => {
    setDefaultWorkspaceSession(
      typeof argv.session === 'string' && argv.session.length > 0 ? argv.session : undefined
    );
  })
  .demandCommand(1)
  .strict()
  .help()
  .alias('help', 'h')
  .alias('version', 'v')
  .wrap(120)
  .epilog(`Key Features:
  --frame               Target an iframe by CSS selector ("#my-iframe") or index (1 = first iframe).
                        Works on click, fill, select, drag, eval, query, styles, snapshot, dismiss-overlays.
  --text/--nth          Click/drag by visible text with multi-match disambiguation
  --within              Scope element search to a container
  --wait-for            Wait for selector/text/idle after navigation
  --wait-for-navigation Wait for a real document replacement (click, fill, select, press-key, navigate).
                        Watches the frame from --frame; override with --wait-for-frame.
  --wait-for-frame      Frame the waits apply to, by selector or index (defaults to --frame)
  select                Set a <select> by value, --text label, or --index
  --touch               Touch events for mobile testing (click, drag)
  --longpress           Hold before click/drag for mobile patterns

Run "cdp-cli <command> --help" for command-specific options.`)
  .fail((msg, err, yargs) => {
    // Show help when no command provided
    if (msg === 'Not enough non-option arguments: got 0, need at least 1') {
      yargs.showHelp();
      process.exit(0);
    }
    // Custom error handler to output NDJSON format
    if (err) {
      // Validation error from .check() or coerce
      outputThrownError(err, 'VALIDATION_ERROR', { usage: yargs.help() });
    } else if (msg) {
      // Yargs built-in error (missing command, missing required arg, etc)
      outputError(
        msg,
        'ARGUMENT_ERROR',
        { usage: yargs.help() }
      );
    }
    process.exit(1);
  });

cli.command(
  'session <action> [name] [targetId]',
  'Ensure, create, list, adopt into, or remove named workspace sessions',
  (yargs) => yargs
    .positional('action', {
      type: 'string',
      choices: ['create', 'ensure', 'list', 'adopt', 'remove', 'reset', 'metadata-reset'] as const
    })
    .positional('name', { type: 'string', description: 'Workspace session name' })
    .positional('targetId', { type: 'string', description: 'Exact CDP target ID' })
    .option('url', { type: 'string', description: 'Initial URL for session create' })
    .option('shared', {
      type: 'boolean',
      default: false,
      description: 'Use the default shared browser context for compatibility'
    })
    .option('force', {
      type: 'boolean',
      default: false,
      description: 'Confirm removal and isolated-context disposal'
    })
    .option('metadata-only', {
      type: 'boolean',
      default: false,
      description: 'Acknowledge that metadata-reset cannot dispose browser contexts'
    })
    .check((argv) => {
      const action = argv.action as string;
      if (action !== 'list' && action !== 'metadata-reset' && typeof argv.name !== 'string') {
        throw new Error(`session ${action} requires a name`);
      }
      if (action === 'adopt' && typeof argv.targetId !== 'string') {
        throw new Error('session adopt requires an exact targetId');
      }
      if ((action === 'remove' || action === 'reset' || action === 'metadata-reset') && argv.force !== true) {
        throw new Error(`session ${action} requires --force to confirm destructive metadata changes`);
      }
      if (action === 'metadata-reset' && argv['metadata-only'] !== true) {
        throw new Error('session metadata-reset requires --metadata-only acknowledgment');
      }
      return true;
    }),
  async (argv) => {
    let service: WorkspaceSessionService | undefined;
    try {
      const action = argv.action as 'create' | 'ensure' | 'list' | 'adopt' | 'remove' | 'reset' | 'metadata-reset';
      if (action === 'metadata-reset') {
        if (typeof argv.name === 'string') {
          throw new Error('session metadata-reset does not accept a session name; it resets endpoint metadata');
        }
        const store = new SessionStore(defaultWorkspaceSessionStorePath(
          argv['cdp-url'] as string
        ));
        await store.reset({ force: true });
        outputSuccess('Persisted workspace session metadata reset', {
          contextsDisposed: false,
          warning: 'Use only after the dedicated CDP Chrome has stopped; live contexts are not disposed.'
        });
        return;
      }
      service = await WorkspaceSessionService.open(argv['cdp-url'] as string);
      if (action === 'list') {
        outputLines(service.listSessions().map((session) => ({
          ...session,
          boundary: 'BrowserContext provides accident isolation, not a security boundary.'
        })));
      } else if (action === 'create') {
        const created = await service.createSession(argv.name as string, {
          isolation: argv.shared === true ? 'shared' : 'isolated',
          url: argv.url as string | undefined
        });
        outputSuccess('Workspace session created', created);
      } else if (action === 'ensure') {
        const ensured = await service.ensureSession(argv.name as string, {
          isolation: argv.shared === true ? 'shared' : 'isolated',
          url: argv.url as string | undefined,
          background: true
        });
        outputSuccess('Workspace session ensured', ensured);
      } else if (action === 'adopt') {
        const adopted = await service.adoptTarget(
          argv.name as string,
          argv.targetId as string
        );
        outputSuccess('Target adopted by exact ID', adopted);
      } else {
        const name = argv.name as string;
        const daemonClient = new DaemonClient({ cdpUrl: argv['cdp-url'] as string });
        if (!await daemonClient.isRunning()) {
          await daemonClient.startDaemon({ cdpUrl: argv['cdp-url'] as string });
        }
        const ownedService = service;
        service = undefined;
        const result = await coordinateWorkspaceSessionDisposal({
          action,
          name,
          service: ownedService,
          daemonClient,
          openService: () => WorkspaceSessionService.open(argv['cdp-url'] as string)
        });
        outputSuccess(
          action === 'reset' ? 'Workspace session reset' : 'Workspace session removed',
          result
        );
      }
    } catch (error) {
      outputThrownError(error, 'SESSION_COMMAND_FAILED');
      process.exitCode = 1;
    } finally {
      service?.close();
    }
  }
);

// Page management commands
cli.command(
  'list-pages',
  'List all open browser pages',
  {},
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await pages.listPages(context);
  }
);

cli.command(
  'new-page [url]',
  'Create a new page/tab',
  (yargs) => {
    return yargs.positional('url', {
      describe: 'URL to navigate to',
      type: 'string'
    });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await pages.newPage(context, argv.url as string | undefined);
  }
);

cli.command(
  'navigate <action> <page>',
  'Navigate page (URL, back, forward, reload). Supports selector, text, expression, idle, and response waits.',
  (yargs) => {
    return addAdvancedWaitOptions(yargs
      .positional('action', {
        describe: 'URL or action (back, forward, reload)',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('wait-for', {
        type: 'string',
        description: 'Wait for CSS selector to appear after navigation',
        alias: 'w'
      })
      .option('wait-for-text', {
        type: 'string',
        description: 'Wait for text to appear in page body'
      })
      .option('wait-for-idle', {
        type: 'boolean',
        description: 'Wait for network idle and document ready',
        default: false
      })
      .option('timeout', {
        type: 'number',
        description: 'Timeout for wait operations in ms',
        alias: 't',
        default: 10000
      })
      .option('wait-for-frame', {
        type: 'string',
        description: 'Frame these waits apply to, by CSS selector or index. Also the frame --wait-for-navigation watches.'
      })
      .option('wait-for-navigation', {
        type: 'boolean',
        description: 'Wait for a real document replacement (not text presence). Watches the frame from --wait-for-frame, else the main frame.',
        default: false
      })
      .check((argv) => {
        const hint = validateNavigateParams(argv.action as string, argv.page as string);
        if (hint.likely) {
          throw new Error(buildErrorWithHint('Invalid parameter order', hint));
        }
        return true;
      }));
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    const waitOptions = waitOptionsFromArgv(argv as Record<string, unknown>);
    await pages.navigate(
      context,
      argv.action as string,
      argv.page as string,
      waitOptions
    );
  }
);

cli.command(
  'close-page <idOrTitle>',
  'Close a page',
  (yargs) => {
    return yargs.positional('idOrTitle', {
      describe: 'Page ID or title',
      type: 'string'
    });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await pages.closePage(context, argv.idOrTitle as string);
  }
);

cli.command(
  'wait <page>',
  'Wait on an existing page without dispatching an action',
  (yargs) => yargs
    .positional('page', { type: 'string', description: 'Page ID or title (exact page ID when --session is set)' })
    .option('wait-for', { type: 'string', description: 'Wait for a CSS selector' })
    .option('wait-for-text', { type: 'string', description: 'Wait for page-body text' })
    .option('expression', { type: 'string', description: 'Wait until this JavaScript expression resolves truthy' })
    .option('expression-file', { type: 'string', description: 'Read the JavaScript expression from this file' })
    .option('expression-stdin', { type: 'boolean', default: false, description: 'Read the JavaScript expression from standard input' })
    .option('wait-for-idle', { type: 'boolean', default: false, description: 'Wait for network idle and document ready' })
    .option('wait-for-frame', { type: 'string', description: 'Frame selector or index for selector/text/expression waits' })
    .option('wait-for-response', { type: 'string', description: 'Wait for a response whose URL contains this literal substring' })
    .option('wait-for-status', { type: 'number', description: 'With --wait-for-response, require this HTTP status' })
    .option('wait-for-body-text', { type: 'string', description: 'With --wait-for-response, require literal body text (never printed)' })
    .option('timeout', { type: 'number', default: 10000, description: 'Timeout for each wait condition in ms' }),
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    try {
      const result = await waitForPageConditions(
        context,
        argv.page as string,
        standaloneWaitOptionsFromArgv(argv as Record<string, unknown>)
      );
      outputSuccess('Wait complete', result);
    } catch (error) {
      outputThrownError(error, 'WAIT_FAILED', { page: argv.page as string });
      process.exitCode = 1;
    }
  }
);

cli.command(
  'resize-window <page> <width> <height>',
  'Resize the Chrome window containing the specified page',
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .positional('width', {
        describe: 'Window width in pixels',
        type: 'number',
        coerce: (value: unknown) => {
          const num = Number(value);
          if (!Number.isFinite(num) || num <= 0) {
            throw new Error('Width must be a positive number');
          }
          return num;
        }
      })
      .positional('height', {
        describe: 'Window height in pixels',
        type: 'number',
        coerce: (value: unknown) => {
          const num = Number(value);
          if (!Number.isFinite(num) || num <= 0) {
            throw new Error('Height must be a positive number');
          }
          return num;
        }
      })
      .option('state', {
        type: 'string',
        description: 'Window state (normal, maximized, minimized, fullscreen)',
        choices: ['normal', 'maximized', 'minimized', 'fullscreen'] as const
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await pages.resizeWindow(
      context,
      argv.page as string,
      {
        width: argv.width as number,
        height: argv.height as number,
        state: argv.state as 'normal' | 'maximized' | 'minimized' | 'fullscreen' | undefined
      }
    );
  }
);

cli.command(
  'page-health <page>',
  'Inspect page focus, visibility, viewport, and browser window state without activating it',
  (yargs) => yargs.positional('page', {
    describe: 'Page ID or title',
    type: 'string'
  }),
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await pages.pageHealth(context, argv.page as string);
  }
);

cli.command(
  'activate-page <page>',
  'Explicitly activate a page and bring it to the foreground',
  (yargs) => yargs.positional('page', {
    describe: 'Page ID or title',
    type: 'string'
  }),
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await pages.activatePage(context, argv.page as string);
  }
);

// Debug commands
cli.command(
  'list-console <page>',
  LIST_CONSOLE_DESCRIPTION,
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('type', {
        type: 'string',
        description: 'Filter by message type (log, error, warn, info)',
        alias: 't'
      })
      .option('duration', {
        type: 'number',
        description: 'Bounded collection window in seconds (default 30, max 3600)',
        alias: 'd'
      })
      .option('follow', {
        type: 'boolean',
        description: 'Stream until interrupted (SIGINT/SIGTERM). Prefer `logs console` for queries.',
        alias: 'f',
        default: false
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.listConsole(context, {
      type: argv.type as string | undefined,
      page: argv.page as string,
      duration: argv.duration as number | undefined,
      follow: argv.follow as boolean
    });
  }
);

cli.command(
  'snapshot <page>',
  'Take a page snapshot. Options: --format (ax|text), --frame',
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('format', {
        type: 'string',
        description: 'Snapshot format (ax, text)',
        alias: 'f',
        default: 'ax'
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector (e.g. "#myframe") or index (1 = first iframe)'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.snapshot(context, {
      format: argv.format as string,
      page: argv.page as string,
      frame: argv.frame as string | undefined
    });
  }
);

cli.command(
  'eval <expression> <page>',
  'Evaluate JavaScript expression. Options: --file, --async, --frame',
  (yargs) => {
    return yargs
      .positional('expression', {
        describe: 'JavaScript expression (ignored when --file used)',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('file', {
        alias: 'f',
        type: 'string',
        description: 'Path to JS file to evaluate'
      })
      .option('async', {
        alias: 'a',
        type: 'boolean',
        description: 'Wrap code in async IIFE for await support',
        default: false
      })
      .option('stdin', {
        type: 'boolean',
        description: 'Read JavaScript from stdin instead of expression argument',
        default: false
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector (e.g. "#myframe") or index (1 = first iframe)'
      })
      .check((argv) => {
        // If --file or --stdin is used, ignore expression validation
        if (!argv.file && !argv.stdin) {
          const hint = validateEvalParams(argv.expression as string, argv.page as string);
          if (hint.likely) {
            throw new Error(buildErrorWithHint('Invalid parameter order', hint));
          }
        }
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.evaluate(context, argv.expression as string, {
      page: argv.page as string,
      file: argv.file as string | undefined,
      async: argv.async as boolean,
      frame: argv.frame as string | undefined,
      stdin: argv.stdin as boolean
    });
  }
);

cli.command(
  'screenshot <page>',
  'Take a screenshot',
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('output', {
        type: 'string',
        description: 'Output file path',
        alias: 'o'
      })
      .option('format', {
        type: 'string',
        description: 'Image format (jpeg, png, webp). Defaults to the output file extension when available.',
        alias: 'f'
      })
      .option('quality', {
        type: 'number',
        description: 'JPEG quality (0-100)',
        alias: 'q',
        default: 90
      })
      .option('scale', {
        type: 'number',
        description: 'Scale factor to resize the image (0 < scale <= 1)',
        alias: 's'
      })
      .option('selector', {
        type: 'string',
        description: 'CSS selector to capture a specific element instead of the full page'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.screenshot(context, {
      output: argv.output as string | undefined,
      format: argv.format as string,
      quality: argv.quality as number,
      scale: argv.scale as number | undefined,
      page: argv.page as string,
      selector: argv.selector as string | undefined
    });
  }
);

cli.command(
  'dialog <page>',
  'Check for or handle JavaScript dialogs (alert/confirm/prompt)',
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('dismiss', {
        type: 'boolean',
        description: 'Dismiss (cancel) the dialog',
        alias: 'd'
      })
      .option('accept', {
        type: 'boolean',
        description: 'Accept (OK) the dialog',
        alias: 'a'
      })
      .option('prompt-text', {
        type: 'string',
        description: 'Text to enter for prompt dialogs before accepting',
        alias: 't'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.dialog(context, {
      page: argv.page as string,
      dismiss: argv.dismiss as boolean | undefined,
      accept: argv.accept as boolean | undefined,
      promptText: argv['prompt-text'] as string | undefined
    });
  }
);

// Network commands
cli.command(
  'list-network <page>',
  LIST_NETWORK_DESCRIPTION,
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('type', {
        type: 'string',
        description: 'Filter by request type (xhr, fetch, script, etc)',
        alias: 't'
      })
      .option('duration', {
        type: 'number',
        description: 'Bounded collection window in seconds (default 30, max 3600)',
        alias: 'd'
      })
      .option('follow', {
        type: 'boolean',
        description: 'Stream until interrupted (SIGINT/SIGTERM). Prefer `logs network` for queries.',
        alias: 'f',
        default: false
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await network.listNetwork(context, {
      type: argv.type as string | undefined,
      page: argv.page as string,
      duration: argv.duration as number | undefined,
      follow: argv.follow as boolean
    });
  }
);

// Input commands
cli.command(
  'click [selector] <page>',
  'Click an element. Supports targeting options plus selector, text, expression, idle, and response waits.',
  (yargs) => {
    return addAdvancedWaitOptions(yargs
      .positional('selector', {
        describe: 'CSS selector',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('double', {
        type: 'boolean',
        description: 'Perform double click',
        alias: 'd',
        default: false
      })
      .option('longpress', {
        type: 'number',
        description: 'Hold mouse button for N seconds before release (defaults to 1 when flag is present without a value)',
        coerce: (value: unknown) => {
          if (value === true) {
            return 1;
          }
          if (value === undefined || value === null) {
            return undefined;
          }
          if (value === '') {
            return 1;
          }
          const num = Number(value);
          if (!Number.isFinite(num) || num < 0) {
            throw new Error('--longpress must be a non-negative number');
          }
          return num;
        }
      })
      .option('text', {
        type: 'string',
        description: 'Match element by visible text instead of CSS selector'
      })
      .option('match', {
        type: 'string',
        description: 'Text matching strategy (exact, contains, regex)',
        choices: ['exact', 'contains', 'regex'] as const,
        default: 'exact'
      })
      .option('case-sensitive', {
        type: 'boolean',
        description: 'Treat text match as case-sensitive',
        default: false
      })
      .option('nth', {
        type: 'number',
        description: 'Select the Nth match when multiple elements match',
        coerce: (value: unknown) => {
          if (value === undefined || value === null || value === '') {
            return undefined;
          }
          const num = Number(value);
          if (!Number.isInteger(num) || num < 1) {
            throw new Error('--nth must be a positive integer');
          }
          return num;
        }
      })
      .option('within', {
        type: 'string',
        description: 'CSS selector to scope the search within a container'
      })
      .option('touch', {
        type: 'boolean',
        description: 'Use touch events instead of mouse events',
        default: false
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector (e.g. "#myframe") or index (1 = first iframe)'
      })
      .option('force', {
        type: 'boolean',
        description: 'Click even when another element covers the click point',
        default: false
      })
      .option('wait-for', {
        type: 'string',
        description: 'CSS selector to wait for after click'
      })
      .option('wait-for-text', {
        type: 'string',
        description: 'Text to wait for after click'
      })
      .option('wait-for-idle', {
        type: 'boolean',
        description: 'Wait for network idle after click',
        default: false
      })
      .option('wait-for-frame', {
        type: 'string',
        description: 'Frame these waits apply to, by CSS selector or index (defaults to --frame). Also the frame --wait-for-navigation watches.'
      })
      .option('wait-for-navigation', {
        type: 'boolean',
        description: 'Wait for a real document replacement (form POST, link, redirect). Watches the frame from --frame; override with --wait-for-frame.',
        default: false
      })
      .option('timeout', {
        type: 'number',
        description: 'Timeout for wait operations in ms (default: 10000)'
      })
      .check((argv) => {
        const hasSelector = typeof argv.selector === 'string' && argv.selector.length > 0;
        const hasText = typeof argv.text === 'string' && argv.text.length > 0;
        if (!hasSelector && !hasText) {
          throw new Error('Provide either a CSS selector or --text');
        }
        if (hasSelector && hasText) {
          throw new Error('CSS selector and --text are mutually exclusive');
        }
        if (
          argv.double === true &&
          typeof argv.longpress === 'number' &&
          argv.longpress > 0
        ) {
          throw new Error('--double cannot be combined with --longpress');
        }
        if (argv.touch === true && argv.double === true) {
          throw new Error('--touch cannot be combined with --double');
        }
        return true;
      }));
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    const waitOptions = waitOptionsFromArgv(argv as Record<string, unknown>);
    await input.click(
      context,
      {
        selector: argv.selector as string | undefined,
        text: argv.text as string | undefined,
        match: argv.match as 'exact' | 'contains' | 'regex',
        caseSensitive: argv.caseSensitive as boolean,
        nth: argv.nth as number | undefined,
        within: argv.within as string | undefined
      },
      {
        page: argv.page as string,
        double: argv.double as boolean,
        longpress: argv.longpress as number | undefined,
        touch: argv.touch as boolean,
        frame: argv.frame as string | undefined,
        force: argv.force as boolean,
        ...waitOptions
      }
    );
  }
);

cli.command(
  'fill <selector> <value> <page>',
  'Fill an input element. Supports targeting options plus selector, text, expression, idle, and response waits.',
  (yargs) => {
    return addAdvancedWaitOptions(yargs
      .positional('selector', {
        describe: 'CSS selector',
        type: 'string'
      })
      .positional('value', {
        describe: 'Value to fill',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('nth', {
        describe: 'Select nth match (1-based) when multiple elements match',
        type: 'number'
      })
      .option('within', {
        type: 'string',
        description: 'CSS selector to scope the search within a container'
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector (e.g. "#myframe") or index (1 = first iframe)'
      })
      .option('expect-value', {
        type: 'boolean',
        description: 'Require the final live value to exactly equal the requested value',
        default: false
      })
      .option('show-value', {
        type: 'boolean',
        description: 'Include requested, actual, and replaced field values in NDJSON (may expose secrets)',
        default: false
      })
      .option('wait-for', {
        type: 'string',
        description: 'CSS selector to wait for after fill'
      })
      .option('wait-for-text', {
        type: 'string',
        description: 'Text to wait for after fill'
      })
      .option('wait-for-idle', {
        type: 'boolean',
        description: 'Wait for network idle after fill',
        default: false
      })
      .option('wait-for-frame', {
        type: 'string',
        description: 'Frame these waits apply to, by CSS selector or index (defaults to --frame). Also the frame --wait-for-navigation watches.'
      })
      .option('wait-for-navigation', {
        type: 'boolean',
        description: 'Wait for a real document replacement (for fills that submit). Watches the frame from --frame; override with --wait-for-frame.',
        default: false
      })
      .option('timeout', {
        type: 'number',
        description: 'Timeout for wait operations in ms (default: 10000)'
      })
      .check((argv) => {
        const hint = validateFillParams(
          argv.selector as string,
          argv.value as string,
          argv.page as string
        );
        if (hint.likely) {
          throw new Error(buildErrorWithHint('Invalid parameter order', hint));
        }
        return true;
      }));
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    const waitOptions = waitOptionsFromArgv(argv as Record<string, unknown>);
    await input.fill(
      context,
      argv.selector as string,
      argv.value as string,
      {
        page: argv.page as string,
        nth: argv.nth as number | undefined,
        within: argv.within as string | undefined,
        frame: argv.frame as string | undefined,
        expectValue: argv['expect-value'] as boolean | undefined,
        showValue: argv['show-value'] as boolean | undefined,
        ...waitOptions
      }
    );
  }
);

cli.command(
  'select <selector> <valueOrPage> [page]',
  'Set a <select> element; supports selector, text, expression, idle, and response waits.',
  (yargs) => {
    return addAdvancedWaitOptions(yargs
      .positional('selector', {
        describe: 'CSS selector for the <select> element',
        type: 'string'
      })
      .positional('valueOrPage', {
        describe: 'Option value, or the page when --text/--index is used',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title (omit when matching by --text/--index)',
        type: 'string'
      })
      .option('text', {
        type: 'string',
        description: 'Match the option by its visible label instead of its value'
      })
      .option('index', {
        type: 'number',
        description: 'Match the Nth option (1-based, same convention as --nth)',
        coerce: (value: unknown) => {
          if (value === undefined || value === null || value === '') {
            return undefined;
          }
          const num = Number(value);
          if (!Number.isInteger(num) || num < 1) {
            throw new Error('--index must be a positive integer (1-based)');
          }
          return num;
        }
      })
      .option('match', {
        type: 'string',
        description: 'Label matching strategy for --text (exact, contains, regex)',
        choices: ['exact', 'contains', 'regex'] as const,
        default: 'exact'
      })
      .option('case-sensitive', {
        type: 'boolean',
        description: 'Treat --text match as case-sensitive',
        default: false
      })
      .option('nth', {
        type: 'number',
        description: 'Select the Nth <select> element when the selector matches several (1-based)'
      })
      .option('within', {
        type: 'string',
        description: 'CSS selector to scope the search within a container'
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector (e.g. "#myframe") or index (1 = first iframe)'
      })
      .option('wait-for', {
        type: 'string',
        description: 'CSS selector to wait for after selecting'
      })
      .option('wait-for-text', {
        type: 'string',
        description: 'Text to wait for after selecting'
      })
      .option('wait-for-idle', {
        type: 'boolean',
        description: 'Wait for network idle after selecting',
        default: false
      })
      .option('wait-for-frame', {
        type: 'string',
        description: 'Frame these waits apply to, by CSS selector or index (defaults to --frame). Also the frame --wait-for-navigation watches.'
      })
      .option('wait-for-navigation', {
        type: 'boolean',
        description: 'Wait for a real document replacement (for selects that submit on change). Watches the frame from --frame; override with --wait-for-frame.',
        default: false
      })
      .option('timeout', {
        type: 'number',
        description: 'Timeout for wait operations in ms (default: 10000)'
      })
      .check((argv) => {
        const hasText = typeof argv.text === 'string' && argv.text.length > 0;
        const hasIndex = typeof argv.index === 'number';
        const byFlag = hasText || hasIndex;

        if (hasText && hasIndex) {
          throw new Error('--text and --index are mutually exclusive');
        }

        // Three positionals means a value was given; two means the second one
        // is the page and the option must be identified by --text/--index.
        const gaveValue = typeof argv.page === 'string' && argv.page.length > 0;

        if (gaveValue && byFlag) {
          throw new Error(
            'A positional value cannot be combined with --text/--index. ' +
            'Use: select <selector> <value> <page>  OR  select <selector> <page> --text "Label"'
          );
        }

        if (!gaveValue && !byFlag) {
          throw new Error(
            'Provide the option to select: select <selector> <value> <page>  OR  select <selector> <page> --text "Label" | --index N'
          );
        }

        return true;
      }));
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    const waitOptions = waitOptionsFromArgv(argv as Record<string, unknown>);

    // Resolved by arity: with three positionals the middle one is the value,
    // with two the second is the page and --text/--index names the option.
    const gaveValue = typeof argv.page === 'string' && (argv.page as string).length > 0;
    const pageRef = gaveValue ? (argv.page as string) : (argv.valueOrPage as string);
    const value = gaveValue ? (argv.valueOrPage as string) : undefined;

    await input.selectOption(
      context,
      argv.selector as string,
      {
        value,
        text: argv.text as string | undefined,
        index: argv.index as number | undefined,
        match: argv.match as 'exact' | 'contains' | 'regex',
        caseSensitive: argv.caseSensitive as boolean
      },
      {
        page: pageRef,
        nth: argv.nth as number | undefined,
        within: argv.within as string | undefined,
        frame: argv.frame as string | undefined,
        ...waitOptions
      }
    );
  }
);

cli.command(
  'press-key <key> <page>',
  'Press a keyboard key. Supports selector, text, expression, idle, response, and navigation waits.',
  (yargs) => {
    return addAdvancedWaitOptions(yargs
      .positional('key', {
        describe: 'Key name (enter, tab, escape, etc)',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('wait-for', {
        type: 'string',
        description: 'CSS selector to wait for after the keystroke'
      })
      .option('wait-for-text', {
        type: 'string',
        description: 'Text to wait for after the keystroke'
      })
      .option('wait-for-idle', {
        type: 'boolean',
        description: 'Wait for network idle after the keystroke',
        default: false
      })
      .option('wait-for-frame', {
        type: 'string',
        description: 'Frame these waits apply to, by CSS selector or index (defaults to --frame). Also the frame --wait-for-navigation watches.'
      })
      .option('wait-for-navigation', {
        type: 'boolean',
        description: 'Wait for a real document replacement (Enter submitting a form). Watches the frame from --wait-for-frame, else the main frame.',
        default: false
      })
      .option('timeout', {
        type: 'number',
        description: 'Timeout for wait operations in ms (default: 10000)'
      })
      .check((argv) => {
        const hint = validatePressKeyParams(argv.key as string, argv.page as string);
        if (hint.likely) {
          throw new Error(buildErrorWithHint('Invalid parameter order', hint));
        }
        return true;
      }));
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    const waitOptions = waitOptionsFromArgv(argv as Record<string, unknown>);
    await input.pressKey(context, argv.key as string, {
      page: argv.page as string,
      ...waitOptions
    });
  }
);

cli.command(
  'drag <from> <to> <page>',
  'Drag from one element/position to another. Options: --touch, --longpress, --steps, --duration, --text, --to-text, --frame',
  (yargs) => {
    return yargs
      .positional('from', {
        describe: 'Source: CSS selector or x,y coordinates',
        type: 'string'
      })
      .positional('to', {
        describe: 'Destination: CSS selector or x,y coordinates',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('touch', {
        type: 'boolean',
        description: 'Use touch events instead of mouse events',
        default: false
      })
      .option('longpress', {
        type: 'number',
        description: 'Hold at start position before dragging (seconds)',
        coerce: (value: unknown) => {
          if (value === true) return 1;
          if (value === undefined || value === null || value === '') return undefined;
          const num = Number(value);
          if (!Number.isFinite(num) || num < 0) {
            throw new Error('--longpress must be a non-negative number');
          }
          return num;
        }
      })
      .option('steps', {
        type: 'number',
        description: 'Number of intermediate move events',
        default: 10
      })
      .option('duration', {
        type: 'number',
        description: 'Total drag duration in milliseconds',
        default: 300
      })
      .option('text', {
        type: 'string',
        description: 'Match source element by visible text'
      })
      .option('to-text', {
        type: 'string',
        description: 'Match destination element by visible text'
      })
      .option('match', {
        type: 'string',
        description: 'Text matching strategy (exact, contains, regex)',
        choices: ['exact', 'contains', 'regex'] as const,
        default: 'exact'
      })
      .option('case-sensitive', {
        type: 'boolean',
        description: 'Treat text match as case-sensitive',
        default: false
      })
      .option('nth', {
        type: 'number',
        description: 'Select Nth source match'
      })
      .option('to-nth', {
        type: 'number',
        description: 'Select Nth destination match'
      })
      .option('within', {
        type: 'string',
        description: 'CSS selector to scope source search'
      })
      .option('to-within', {
        type: 'string',
        description: 'CSS selector to scope destination search'
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector (e.g. "#myframe") - applies to both source and destination'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);

    // Parse from target
    const fromStr = argv.from as string;
    const coordsFrom = fromStr.match(/^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
    const fromTarget = coordsFrom
      ? { x: parseFloat(coordsFrom[1]), y: parseFloat(coordsFrom[2]) }
      : {
          selector: argv.text ? undefined : fromStr,
          text: argv.text as string | undefined,
          match: argv.match as 'exact' | 'contains' | 'regex',
          caseSensitive: argv.caseSensitive as boolean,
          nth: argv.nth as number | undefined,
          within: argv.within as string | undefined
        };

    // Parse to target
    const toStr = argv.to as string;
    const coordsTo = toStr.match(/^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
    const toTarget = coordsTo
      ? { x: parseFloat(coordsTo[1]), y: parseFloat(coordsTo[2]) }
      : {
          selector: argv.toText ? undefined : toStr,
          text: argv.toText as string | undefined,
          match: argv.match as 'exact' | 'contains' | 'regex',
          caseSensitive: argv.caseSensitive as boolean,
          nth: argv.toNth as number | undefined,
          within: argv.toWithin as string | undefined
        };

    await input.drag(context, fromTarget, toTarget, {
      page: argv.page as string,
      touch: argv.touch as boolean,
      longpress: argv.longpress as number | undefined,
      steps: argv.steps as number,
      duration: argv.duration as number,
      frame: argv.frame as string | undefined
    });
  }
);

// Daemon commands
cli.command(
  'daemon <action>',
  'Manage the CDP daemon (start, stop, status)',
  (yargs) => {
    return yargs.positional('action', {
      describe: 'Action to perform',
      type: 'string',
      choices: ['start', 'stop', 'status']
    })
    .option('buffer-size', {
      type: 'number',
      description: 'Max log entries per page (default: 500)',
      default: 500
    });
  },
  async (argv) => {
    const action = argv.action as string;
    if (action === 'start') {
      await daemon.startDaemon({
        cdpUrl: argv['cdp-url'] as string,
        bufferSize: argv['buffer-size'] as number
      });
    } else if (action === 'stop') {
      await daemon.stopDaemon({ cdpUrl: argv['cdp-url'] as string });
    } else if (action === 'status') {
      await daemon.daemonStatus({ cdpUrl: argv['cdp-url'] as string });
    }
  }
);

// Logs commands
cli.command(
  'logs <type> <page>',
  'Get logs from daemon (console, network, clear)',
  (yargs) => {
    return yargs
      .positional('type', {
        describe: 'Log type',
        type: 'string',
        choices: ['console', 'network', 'clear']
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('last', {
        type: 'number',
        description: 'Get last N entries (0 for all)',
        alias: 'n',
        default: 20
      })
      .option('filter', {
        type: 'string',
        description: 'Filter by type (log/error/warn for console, xhr/fetch/etc for network)',
        alias: 'f'
      })
      .option('url', {
        type: 'string',
        description: 'For network logs, require this URL substring'
      })
      .option('method', {
        type: 'string',
        description: 'For network logs, require this HTTP method'
      })
      .option('status', {
        type: 'number',
        description: 'For network logs, require this response status'
      })
      .option('failed', {
        type: 'boolean',
        description: 'For network logs, include only failed requests'
      })
      .option('since', {
        type: 'number',
        description: 'For network logs, include entries at or after this epoch-millisecond timestamp'
      })
      .check((argv) => {
        const hint = validateLogsParams(argv.type as string, argv.page as string);
        if (hint.likely) {
          throw new Error(buildErrorWithHint('Invalid parameter order', hint));
        }
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    const logType = argv.type as string;

    if (logType === 'console') {
      await logs.getConsoleLogs(context, {
        page: argv.page as string,
        last: argv.last as number | undefined,
        type: argv.filter as string | undefined
      });
    } else if (logType === 'network') {
      await logs.getNetworkLogs(context, {
        page: argv.page as string,
        last: argv.last as number | undefined,
        type: argv.filter as string | undefined,
        url: argv.url as string | undefined,
        method: argv.method as string | undefined,
        status: argv.status as number | undefined,
        failed: argv.failed as boolean | undefined,
        since: argv.since as number | undefined
      });
    } else if (logType === 'clear') {
      await logs.clearLogs(context, {
        page: argv.page as string
      });
    }
  }
);

cli.command(
  'logs-detail <messageId> <page>',
  'Get console message details with stack trace',
  (yargs) => {
    return yargs
      .positional('messageId', {
        describe: 'Console message ID',
        type: 'number'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .check((argv) => {
        const hint = validateLogsDetailParams(argv.messageId as number, argv.page as string);
        if (hint.likely) {
          throw new Error(buildErrorWithHint('Invalid parameter order', hint));
        }
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await logs.getConsoleDetail(context, {
      page: argv.page as string,
      messageId: argv.messageId as number
    });
  }
);

cli.command(
  'network-detail <requestId> <page>',
  'Get the complete recorded lifecycle for one network request',
  (yargs) => yargs
    .positional('requestId', {
      describe: 'Chrome network request ID',
      type: 'string'
    })
    .positional('page', {
      describe: 'Page ID or title',
      type: 'string'
    })
    .option('body', {
      type: 'boolean',
      description: 'Include a bounded response body (may contain sensitive application data)',
      default: false
    })
    .option('max-body-bytes', {
      type: 'number',
      description: 'Maximum response-body bytes to emit',
      default: 65536
    }),
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await logs.getNetworkDetail(context, {
      page: argv.page as string,
      requestId: argv.requestId as string,
      body: argv.body as boolean,
      maxBodyBytes: argv['max-body-bytes'] as number
    });
  }
);

// Status command
cli.command(
  'status',
  'Check daemon and Chrome connection status',
  () => {},
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.status(context);
  }
);

// Doctor command
cli.command(
  'doctor',
  'Verify every caller (cmd.exe, sh, PHP exec) resolves the same cdp-cli build',
  () => {},
  async () => {
    await doctor.doctor();
  }
);

// Ready command
cli.command(
  'ready',
  'Launch Chrome + start daemon + return pages',
  (yargs) => {
    return yargs
      .option('profile', {
        alias: 'p',
        type: 'string',
        description: 'Chrome profile directory',
        default: join(homedir(), 'cdp-cli-profile')
      })
      .option('port', {
        type: 'number',
        description: 'CDP port',
        default: 9222
      })
      .option('headless', {
        type: 'boolean',
        default: false,
        description: 'Launch Chrome without visible windows'
      });
  },
  async (argv) => {
    await lifecycle.ready({
      profile: argv.profile as string,
      port: argv.port as number,
      cdpUrl: argv['cdp-url'] as string,
      headless: argv.headless as boolean
    });
  }
);

// Query command
cli.command(
  'query <selector> <page>',
  'Query DOM elements. Options: --text, --html, --attrs, --styles, --all, --frame',
  (yargs) => {
    return yargs
      .positional('selector', {
        describe: 'CSS selector',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('text', {
        type: 'boolean',
        description: 'Return textContent',
        default: false
      })
      .option('html', {
        type: 'boolean',
        description: 'Return innerHTML (trimmed, max 2000 chars)',
        default: false
      })
      .option('attrs', {
        type: 'boolean',
        description: 'Return all attributes as key-value pairs',
        default: false
      })
      .option('styles', {
        type: 'string',
        description: 'Return specified computed style properties (comma-separated, e.g. color,fontSize)'
      })
      .option('all', {
        type: 'boolean',
        description: 'Query all matching elements (querySelectorAll)',
        default: false
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector or index'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.query(context, argv.selector as string, {
      page: argv.page as string,
      text: argv.text as boolean,
      html: argv.html as boolean,
      attrs: argv.attrs as boolean,
      styles: argv.styles as string | undefined,
      all: argv.all as boolean,
      frame: argv.frame as string | undefined
    });
  }
);

// Styles command
cli.command(
  'styles <selector> <page>',
  'Extract computed styles. Options: --compare-siblings, --props, --frame',
  (yargs) => {
    return yargs
      .positional('selector', {
        describe: 'CSS selector',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('compare-siblings', {
        type: 'boolean',
        description: 'Include parent and sibling computed styles for comparison',
        default: false
      })
      .option('props', {
        type: 'string',
        description: 'CSS properties to extract (comma-separated, default: color,fontSize,fontWeight,textAlign,margin,padding,lineHeight,display)'
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector or index'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.styles(context, argv.selector as string, {
      page: argv.page as string,
      compareSiblings: argv['compare-siblings'] as boolean,
      props: argv.props as string | undefined,
      frame: argv.frame as string | undefined
    });
  }
);

// Emulate command
cli.command(
  'emulate <device> <page>',
  'Emulate a device (ipad, iphone, desktop). Options: --width, --height, --scale, --ua, --touch',
  (yargs) => {
    return yargs
      .positional('device', {
        describe: 'Device preset (ipad, iphone, desktop) or custom name with flags',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('width', {
        type: 'number',
        description: 'Override viewport width'
      })
      .option('height', {
        type: 'number',
        description: 'Override viewport height'
      })
      .option('scale', {
        type: 'number',
        description: 'Device scale factor (deviceScaleFactor)'
      })
      .option('ua', {
        type: 'string',
        description: 'Custom user agent string'
      })
      .option('touch', {
        type: 'boolean',
        description: 'Enable touch emulation'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.emulate(context, argv.device as string, {
      page: argv.page as string,
      width: argv.width as number | undefined,
      height: argv.height as number | undefined,
      scale: argv.scale as number | undefined,
      ua: argv.ua as string | undefined,
      touch: argv.touch as boolean | undefined,
    });
  }
);

// Dismiss overlays command
cli.command(
  'dismiss-overlays <page>',
  'Auto-dismiss toasts, notifications, and modal overlays',
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector or index'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.dismissOverlays(context, {
      page: argv.page as string,
      frame: argv.frame as string | undefined
    });
  }
);

cli.command(
  'diagnose <page>',
  'Collect a bounded, redacted diagnostic bundle; optionally persist a manifest and screenshot',
  (yargs) => yargs
    .positional('page', {
      describe: 'Page ID or title',
      type: 'string'
    })
    .option('output-dir', {
      type: 'string',
      description: 'Write manifest.json and screenshot.png into this directory'
    }),
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await diagnose.diagnosePage(context, {
      page: argv.page as string,
      outputDir: argv['output-dir'] as string | undefined
    });
  }
);

cli.command(
  'targets',
  'List exact page and out-of-process iframe targets',
  (yargs) => yargs,
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    try {
      outputLines(await targets.listTargets(context));
    } catch (error) {
      outputThrownError(error, 'TARGETS_FAILED');
      process.exitCode = 1;
    }
  }
);

cli.command(
  'target <targetId>',
  'Resolve one literal target ID (titles and URLs are never accepted)',
  (yargs) => yargs.positional('targetId', { type: 'string', demandOption: true }),
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    try {
      outputSuccess('Target resolved', await targets.resolveTarget(context, argv.targetId as string));
    } catch (error) {
      outputThrownError(error, 'TARGET_RESOLVE_FAILED', { targetId: argv.targetId });
      process.exitCode = 1;
    }
  }
);

cli.command(
  'target-frame <parentTargetId> <selector>',
  'Resolve an iframe selector to its exact OOPIF target',
  (yargs) => yargs
    .positional('parentTargetId', { type: 'string', demandOption: true })
    .positional('selector', { type: 'string', demandOption: true }),
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    try {
      outputSuccess('Iframe target resolved', await targets.resolveIframeTarget(
        context,
        argv.parentTargetId as string,
        argv.selector as string
      ));
    } catch (error) {
      outputThrownError(error, 'TARGET_FRAME_RESOLVE_FAILED');
      process.exitCode = 1;
    }
  }
);

cli.command(
  'target-eval <expression> <targetId>',
  'Evaluate JavaScript in the exact target default context',
  (yargs) => yargs
    .positional('expression', { type: 'string', demandOption: true })
    .positional('targetId', { type: 'string', demandOption: true }),
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    try {
      outputSuccess('Target evaluation complete', await targets.evaluateTarget(
        context,
        argv.targetId as string,
        argv.expression as string
      ));
    } catch (error) {
      outputThrownError(error, 'TARGET_EVAL_FAILED');
      process.exitCode = 1;
    }
  }
);

cli.command(
  'target-query <selector> <targetId>',
  'Inspect one unique element in an exact page or OOPIF target',
  (yargs) => yargs
    .positional('selector', { type: 'string', demandOption: true })
    .positional('targetId', { type: 'string', demandOption: true })
    .option('show-value', {
      type: 'boolean',
      description: 'Include the field value in NDJSON (may expose payment or credential data)',
      default: false
    }),
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    try {
      const result = await targets.queryTarget(
        context,
        argv.targetId as string,
        argv.selector as string
      );
      outputSuccess('Target element inspected', argv['show-value'] === true
        ? result
        : { ...result, value: null, valueRedacted: true });
    } catch (error) {
      outputThrownError(error, 'TARGET_QUERY_FAILED');
      process.exitCode = 1;
    }
  }
);

cli.command(
  'target-fill <selector> <value> <targetId>',
  'Fill and read back one unique element in an exact page or OOPIF target',
  (yargs) => yargs
    .positional('selector', { type: 'string', demandOption: true })
    .positional('value', { type: 'string', demandOption: true })
    .positional('targetId', { type: 'string', demandOption: true })
    .option('expect-value', {
      type: 'boolean',
      description: 'Require exact equality after target-local formatting',
      default: false
    })
    .option('show-value', {
      type: 'boolean',
      description: 'Include field values in NDJSON (may expose payment or credential data)',
      default: false
    }),
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    try {
      const result = await targets.fillTarget(
        context,
        argv.targetId as string,
        argv.selector as string,
        argv.value as string
      );
      const valueLost = result.requestedValue.length > 0 && result.actualValue === '';
      const publicResult = argv['show-value'] === true
        ? result
        : {
            ...result,
            requestedValue: undefined,
            previousValue: undefined,
            actualValue: undefined,
            requestedValueLength: result.requestedValue.length,
            previousValueLength: result.previousValue?.length ?? null,
            actualValueLength: result.actualValue?.length ?? null,
            valueRedacted: true,
            state: {
              ...result.state,
              value: null,
              valueRedacted: true,
              valueLength: result.state.valueLength
            }
          };
      if (valueLost || (argv['expect-value'] === true && !result.valueApplied)) {
        outputError('Target fill value was not applied', 'FILL_VALUE_NOT_APPLIED', publicResult);
        process.exitCode = 1;
        return;
      }
      outputSuccess('Target fill performed', publicResult);
    } catch (error) {
      outputThrownError(error, 'TARGET_FILL_FAILED');
      process.exitCode = 1;
    }
  }
);

cli.command(
  'target-press-key <key> <targetId>',
  'Dispatch one key pair in an exact page or OOPIF target',
  (yargs) => yargs
    .positional('key', { type: 'string', demandOption: true })
    .positional('targetId', { type: 'string', demandOption: true })
    .option('selector', { type: 'string', description: 'Focus this unique target-local element first' }),
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    try {
      outputSuccess('Target key dispatched', await targets.pressKeyTarget(
        context,
        argv.targetId as string,
        argv.key as string,
        { selector: argv.selector as string | undefined }
      ));
    } catch (error) {
      outputThrownError(error, 'TARGET_KEY_FAILED');
      process.exitCode = 1;
    }
  }
);

// Parse and execute
cli.parse();
