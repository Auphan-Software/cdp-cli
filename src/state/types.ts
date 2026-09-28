export interface StateElement {
  k: string;
  kq: 'strong' | 'weak' | 'ambiguous';
  role: string;
  name?: string;
  text?: string;
  value?: { len: number; h: string };
  state?: Record<string, boolean | string>;
  box?: [number, number, number, number];
}

export interface PageState {
  schema: 'cdp-cli.page-state/1';
  id: string;
  seq: number;
  name?: string;
  capturedAt: string;
  targetId: string;
  session?: string;
  captureProfile: string;
  url: string;
  title: string;
  readyState: string;
  focus?: string;
  bodyTextHash: string;
  nodeCount: number;
  elements: StateElement[];
  coverage: { truncated: boolean; unreachableFrames: string[]; blockedByDialog: boolean;
    dialogProbeUnavailable?: boolean; actionUnverified?: boolean; ambiguousKeys?: string[]; unstable?: boolean; volatileKeys?: string[] };
  settle?: { waitedMs: number; stable: boolean };
  dialog?: { type: string; messageLength: number };
  digest: string;
}

export interface StateChange {
  kind: 'added' | 'removed' | 'field' | 'navigation' | 'text-unmodelled' | 'dialog';
  key?: string;
  field?: string;
  from?: unknown;
  to?: unknown;
}

export interface StateDiff {
  from: { id: string; seq: number; name?: string };
  to: { id: string; seq: number; name?: string };
  changed: boolean | null;
  coverage: PageState['coverage'];
  counts: { added: number; removed: number; changed: number };
  changes: StateChange[];
}
