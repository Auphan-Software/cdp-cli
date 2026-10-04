/** Independent final-report oracle; never exposed as an agent tool. */
export function verifyWorkflowReport(text: string, expectedFinding: string, finalScreen: string,
  screenshots: Array<{ artifact: string; screen: string }>, consoles: Array<{ screen: string; errors: string[] }>) {
  let report: any;
  try { report = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return { diagnosed: false }; }
  const diagnosed = report?.finding === expectedFinding &&
    typeof report.screenshotArtifact === 'string' && typeof report.consoleError === 'string' && report.consoleError.length > 0 &&
    screenshots.some(s => s.screen === finalScreen && s.artifact === report.screenshotArtifact) &&
    consoles.some(c => c.screen === finalScreen && c.errors.includes(report.consoleError));
  return { report, diagnosed };
}
