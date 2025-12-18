/**
 * Debugging commands: console, snapshot, eval, screenshot
 */

import { CDPContext, ConsoleMessage } from '../context.js';
import { outputLine, outputError, outputSuccess, outputRaw } from '../output.js';
import { writeFileSync } from 'fs';
import { extname } from 'node:path';

/**
 * List console messages
 */
export async function listConsole(
  context: CDPContext,
  options: { type?: string; page: string; duration?: number }
): Promise<void> {
  let ws;
  const duration = options.duration ?? 0;
  try {
    // Get page to monitor
    const page = await context.findPage(options.page);

    // Connect and enable Runtime domain
    ws = await context.connect(page);
    context.setupConsoleCollection(ws, (message: ConsoleMessage) => {
      if (options.type && message.type !== options.type) {
        return;
      }

      outputLine({
        type: message.type,
        timestamp: message.timestamp,
        text: message.text,
        source: message.source,
        ...(message.line !== undefined && { line: message.line }),
        ...(message.url && { url: message.url })
      });
    });
    await context.sendCommand(ws, 'Runtime.enable');

    if (duration > 0) {
      await new Promise(resolve => setTimeout(resolve, duration * 1000));
    } else {
      await new Promise<void>((resolve) => {
        function cleanup(): void {
          process.off('SIGINT', onSigint);
          process.off('SIGTERM', onSigterm);
        }

        function onSigint(): void {
          process.exitCode = 130;
          cleanup();
          resolve();
        }

        function onSigterm(): void {
          process.exitCode = 143;
          cleanup();
          resolve();
        }

        process.on('SIGINT', onSigint);
        process.on('SIGTERM', onSigterm);
      });
    }
  } catch (error) {
    outputError(
      (error as Error).message,
      'LIST_CONSOLE_FAILED'
    );
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}

/**
 * Take a snapshot of the page (DOM or accessibility tree)
 */
export async function snapshot(
  context: CDPContext,
  options: { format?: string; page: string }
): Promise<void> {
  let ws;
  try {
    // Get page
    const page = await context.findPage(options.page);

    ws = await context.connect(page);

    const format = options.format || 'text';

    if (format === 'text') {
      // Simple text snapshot
      await context.sendCommand(ws, 'Runtime.enable');
      const result = await context.sendCommand(ws, 'Runtime.evaluate', {
        expression: 'document.body.innerText',
        returnByValue: true
      });

      outputRaw(result.result?.value || '');
    } else if (format === 'dom') {
      // DOM snapshot
      await context.sendCommand(ws, 'DOM.enable');
      const doc = await context.sendCommand(ws, 'DOM.getDocument', {
        depth: -1,
        pierce: true
      });

      outputLine(doc);
    } else if (format === 'ax') {
      // Accessibility tree snapshot
      await context.sendCommand(ws, 'Accessibility.enable');
      const ax = await context.sendCommand(ws, 'Accessibility.getFullAXTree');

      outputLine(ax);
    } else {
      throw new Error(`Unknown snapshot format: ${format}`);
    }
  } catch (error) {
    outputError(
      (error as Error).message,
      'SNAPSHOT_FAILED',
      { format: options.format }
    );
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}

/**
 * Evaluate JavaScript expression
 */
export async function evaluate(
  context: CDPContext,
  expression: string,
  options: { page: string }
): Promise<void> {
  let ws;
  try {
    // Get page
    const page = await context.findPage(options.page);

    ws = await context.connect(page);

    await context.sendCommand(ws, 'Runtime.enable');
    const result = await context.sendCommand(ws, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });

    if (result.exceptionDetails) {
      outputError(
        result.exceptionDetails.text,
        'EVAL_EXCEPTION',
        result.exceptionDetails
      );
      process.exit(1);
    }

    outputLine({
      success: true,
      value: result.result?.value,
      type: result.result?.type
    });
  } catch (error) {
    outputError(
      (error as Error).message,
      'EVAL_FAILED',
      { expression }
    );
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}

/**
 * Take a screenshot
 */
export async function screenshot(
  context: CDPContext,
  options: { output?: string; format?: string; page: string; quality?: number; scale?: number }
): Promise<void> {
  let ws;
  try {
    // Get page
    const page = await context.findPage(options.page);

    ws = await context.connect(page);

    const validFormats = ['jpeg', 'png', 'webp'];
    const detectedFormat = (() => {
      const explicitFormat = options.format?.toLowerCase();
      if (explicitFormat) {
        return explicitFormat;
      }

      if (!options.output) {
        return undefined;
      }

      const extension = extname(options.output).toLowerCase();
      if (!extension) {
        return undefined;
      }

      const normalizedExtension = extension.slice(1);
      if (normalizedExtension === 'jpg') {
        return 'jpeg';
      }

      if (validFormats.includes(normalizedExtension)) {
        return normalizedExtension;
      }

      return undefined;
    })();

    const format = detectedFormat ?? 'jpeg';

    if (!validFormats.includes(format)) {
      throw new Error(`Invalid format: ${format}. Must be one of: ${validFormats.join(', ')}`);
    }

    const quality = options.quality || 90;
    const scale = options.scale ?? 1;

    if (scale <= 0 || scale > 1) {
      throw new Error(`Invalid scale: ${scale}. Must be between 0 (exclusive) and 1 (inclusive).`);
    }

    const captureParams: Record<string, any> = {
      format,
      quality: format === 'jpeg' ? quality : undefined
    };

    if (scale !== 1) {
      // Get CSS viewport dimensions via JS evaluation (most reliable across browsers)
      await context.sendCommand(ws, 'Runtime.enable');
      const viewportResult = await context.sendCommand(ws, 'Runtime.evaluate', {
        expression: 'JSON.stringify({width: window.innerWidth, height: window.innerHeight})',
        returnByValue: true
      });
      const viewport = JSON.parse(viewportResult.result?.value || '{}');
      const width = viewport.width;
      const height = viewport.height;

      if (!width || !height) {
        throw new Error('Unable to determine page dimensions for scaling.');
      }

      captureParams.clip = {
        x: 0,
        y: 0,
        width,
        height,
        scale
      };
    }

    const result = await context.sendCommand(ws, 'Page.captureScreenshot', captureParams);

    if (options.output) {
      // Save to file
      const buffer = Buffer.from(result.data, 'base64');
      writeFileSync(options.output, buffer);

      outputSuccess('Screenshot saved', {
        file: options.output,
        format,
        size: buffer.length
      });
    } else {
      // Output base64 data
      outputLine({
        success: true,
        format,
        data: result.data
      });
    }
  } catch (error) {
    outputError(
      (error as Error).message,
      'SCREENSHOT_FAILED',
      { output: options.output }
    );
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}
