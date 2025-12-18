#!/usr/bin/env node

/**
 * Chrome DevTools CLI
 * Command-line interface for Chrome DevTools Protocol
 * Optimized for LLM agents with NDJSON output
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { CDPContext } from './context.js';
import * as pages from './commands/pages.js';
import * as debug from './commands/debug.js';
import * as network from './commands/network.js';
import * as input from './commands/input.js';
import * as daemon from './commands/daemon.js';
import * as logs from './commands/logs.js';
import { outputError } from './output.js';
import {
  validateNavigateParams,
  validateEvalParams,
  validateLogsParams,
  validatePressKeyParams,
  validateFillParams,
  validateLogsDetailParams,
  buildErrorWithHint
} from './validation.js';

const DEFAULT_CDP_URL = 'http://localhost:9222';

// Global error handler for unhandled exceptions
process.on('uncaughtException', (error) => {
  outputError(
    error.message || 'An unexpected error occurred',
    'UNCAUGHT_EXCEPTION',
    { stack: error.stack }
  );
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  outputError(
    message || 'An unhandled promise rejection occurred',
    'UNHANDLED_REJECTION',
    { stack }
  );
  process.exit(1);
});

// Create CLI
const cli = yargs(hideBin(process.argv))
  .scriptName('cdp-cli')
  .version('0.1.0')
  .usage('Usage: $0 <command> [options]')
  .option('cdp-url', {
    type: 'string',
    description: 'Chrome DevTools Protocol URL',
    default: DEFAULT_CDP_URL
  })
  .demandCommand(1)
  .strict()
  .help()
  .alias('help', 'h')
  .alias('version', 'v')
  .fail((msg, err, yargs) => {
    // Show help when no command provided
    if (msg === 'Not enough non-option arguments: got 0, need at least 1') {
      yargs.showHelp();
      process.exit(0);
    }
    // Custom error handler to output NDJSON format
    if (err) {
      // Validation error from .check() or coerce
      outputError(
        err.message,
        'VALIDATION_ERROR',
        { usage: yargs.help() }
      );
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
  'Navigate page (URL, back, forward, reload)',
  (yargs) => {
    return yargs
      .positional('action', {
        describe: 'URL or action (back, forward, reload)',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .check((argv) => {
        const hint = validateNavigateParams(argv.action as string, argv.page as string);
        if (hint.likely) {
          throw new Error(buildErrorWithHint('Invalid parameter order', hint));
        }
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await pages.navigate(
      context,
      argv.action as string,
      argv.page as string
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

// Debug commands
cli.command(
  'list-console <page>',
  'List console messages',
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
        description: 'Collection duration in seconds (0 to stream until interrupted)',
        alias: 'd',
        default: 0
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.listConsole(context, {
      type: argv.type as string | undefined,
      page: argv.page as string,
      duration: argv.duration as number
    });
  }
);

cli.command(
  'snapshot <page>',
  'Take a page snapshot',
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('format', {
        type: 'string',
        description: 'Snapshot format (text, dom, ax)',
        alias: 'f',
        default: 'text'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.snapshot(context, {
      format: argv.format as string,
      page: argv.page as string
    });
  }
);

cli.command(
  'eval <expression> <page>',
  'Evaluate JavaScript expression',
  (yargs) => {
    return yargs
      .positional('expression', {
        describe: 'JavaScript expression to evaluate',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .check((argv) => {
        const hint = validateEvalParams(argv.expression as string, argv.page as string);
        if (hint.likely) {
          throw new Error(buildErrorWithHint('Invalid parameter order', hint));
        }
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.evaluate(context, argv.expression as string, {
      page: argv.page as string
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
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.screenshot(context, {
      output: argv.output as string | undefined,
      format: argv.format as string,
      quality: argv.quality as number,
      scale: argv.scale as number | undefined,
      page: argv.page as string
    });
  }
);

// Network commands
cli.command(
  'list-network <page>',
  'List network requests',
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
        description: 'Collection duration in seconds (0 to stream until interrupted)',
        alias: 'd',
        default: 0
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await network.listNetwork(context, {
      type: argv.type as string | undefined,
      page: argv.page as string,
      duration: argv.duration as number
    });
  }
);

// Input commands
cli.command(
  'click [selector] <page>',
  'Click an element',
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
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await input.click(
      context,
      {
        selector: argv.selector as string | undefined,
        text: argv.text as string | undefined,
        match: argv.match as 'exact' | 'contains' | 'regex',
        caseSensitive: argv.caseSensitive as boolean,
        nth: argv.nth as number | undefined
      },
      {
        page: argv.page as string,
        double: argv.double as boolean,
        longpress: argv.longpress as number | undefined
      }
    );
  }
);

cli.command(
  'fill <selector> <value> <page>',
  'Fill an input element',
  (yargs) => {
    return yargs
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
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await input.fill(
      context,
      argv.selector as string,
      argv.value as string,
      {
        page: argv.page as string
      }
    );
  }
);

cli.command(
  'press-key <key> <page>',
  'Press a keyboard key',
  (yargs) => {
    return yargs
      .positional('key', {
        describe: 'Key name (enter, tab, escape, etc)',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .check((argv) => {
        const hint = validatePressKeyParams(argv.key as string, argv.page as string);
        if (hint.likely) {
          throw new Error(buildErrorWithHint('Invalid parameter order', hint));
        }
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await input.pressKey(context, argv.key as string, {
      page: argv.page as string
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
      await daemon.stopDaemon();
    } else if (action === 'status') {
      await daemon.daemonStatus();
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
        type: argv.filter as string | undefined
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

// Parse and execute
cli.parse();
