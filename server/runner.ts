import {randomUUID} from 'node:crypto';
import {Observable, catchError, concat, defer, mergeMap, of} from 'rxjs';
import {readUserContent} from './uploads.js';
import {runOptions} from './pi-config.js';
import type {BaseEvent} from '@ag-ui/client';
import {InMemoryAgentRunner} from '@copilotkit/runtime/v2';
import type {Jobs, Thread} from './jobs.js';

type ConnectRequest = Parameters<InMemoryAgentRunner['connect']>[0];
type RunRequest = Parameters<InMemoryAgentRunner['run']>[0];

/**
 * CopilotChat clears its messages when it opens a thread and rebuilds them from the runner. The
 * in-memory runner forgets everything on restart, so threads opened blank. This runner answers
 * from the saved thread instead, and uses the in-memory replay only to follow a run in progress.
 */
export class PersistedRunner extends InMemoryAgentRunner {
  /** Ids of saved messages that predate this process's first run on each thread. */
  private savedBeforeMemory = new Map<string, Set<string>>();

  constructor(private jobs: Jobs, options: ConstructorParameters<typeof InMemoryAgentRunner>[0]) {
    super(options);
  }

  run(request: RunRequest) {
    // A second message while the thread is working (another tab or device, a stale page, a run the
    // server started from the queue) is queued instead of being rejected as "Thread already running".
    return defer(async () => !!this.jobs.working(request.threadId) || (await this.isRunning({threadId: request.threadId}))).pipe(
      mergeMap(busy => {
        if (busy) return this.queueInstead(request);
        const thread = this.thread(request.threadId);
        if (thread && !this.savedBeforeMemory.has(thread.id)) {
          this.savedBeforeMemory.set(thread.id, new Set(thread.messages.map(message => message.id)));
        }
        return super.run(request);
      }),
    );
  }

  connect(request: ConnectRequest): Observable<BaseEvent> {
    const thread = this.thread(request.threadId);
    if (!thread) return super.connect(request);
    if (!this.jobs.live.has(thread.id)) return snapshot(thread.id, thread.messages);
    // A compaction or measurement started from the app is not a CopilotKit run; show the saved history.
    return defer(async () => this.isRunning({threadId: thread.id})).pipe(
      mergeMap(running => (running ? this.followLive(thread, request) : this.followJob(thread))),
    );
  }

  /**
   * A run the server started itself, from the message queue, or a compaction. Shows what was saved before
   * it, replays its events so far, then streams the rest until it ends.
   */
  private followJob(thread: Thread): Observable<BaseEvent> {
    const live = this.jobs.live.get(thread.id);
    if (!live || live.done) return snapshot(thread.id, thread.messages);
    const before = thread.messages.slice(0, live.baseCount ?? thread.messages.length);
    return new Observable<BaseEvent>(observer => {
      const end = (event: any) => event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR';
      const forward = (event: any) => {
        if (event.type === 'RUN_STARTED') return;
        const {timestamp, ...clean} = event;
        observer.next(clean as BaseEvent);
        if (end(event)) observer.complete();
      };
      observer.next({type: 'RUN_STARTED', threadId: thread.id, runId: live.runId} as BaseEvent);
      observer.next({type: 'MESSAGES_SNAPSHOT', messages: structuredClone(before)} as BaseEvent);
      for (const event of [...thread.events]) forward(event);
      if (observer.closed) return;
      live.bus.on('event', forward);
      return () => live.bus.off('event', forward);
    });
  }

  private followLive(thread: Thread, request: ConnectRequest): Observable<BaseEvent> {
    // A run is streaming. Send what was saved before this process started running the thread,
    // then let the in-memory runner replay this process's runs and follow the live one.
    const earlier = this.savedBeforeMemory.get(thread.id);
    const before = earlier ? thread.messages.filter(message => earlier.has(message.id)) : [];
    return before.length ? concat(snapshot(thread.id, before), super.connect(request)) : super.connect(request);
  }

  private queueInstead(request: RunRequest): Observable<BaseEvent> {
    const {threadId, runId} = request.input;
    return defer(async () => {
      const user = [...request.input.messages].reverse().find(message => message.role === 'user');
      const content = readUserContent(user?.content);
      const options = await runOptions((request.input.forwardedProps ?? {}) as {model?: unknown; thinking?: unknown});
      this.jobs.enqueue(threadId, content, options, {fallback: true});
    }).pipe(
      mergeMap(() => of({type: 'RUN_STARTED', threadId, runId}, {type: 'RUN_FINISHED', threadId, runId}) as Observable<BaseEvent>),
      catchError(error =>
        of({type: 'RUN_STARTED', threadId, runId}, {type: 'RUN_ERROR', message: String(error?.message ?? error)}) as Observable<BaseEvent>,
      ),
    );
  }

  private thread(id: string): Thread | undefined {
    return this.jobs.threads.get(id);
  }
}

function snapshot(threadId: string, messages: any[]): Observable<BaseEvent> {
  const runId = randomUUID();
  return of(
    {type: 'RUN_STARTED', threadId, runId},
    {type: 'MESSAGES_SNAPSHOT', messages: structuredClone(messages)},
    {type: 'RUN_FINISHED', threadId, runId},
  ) as Observable<BaseEvent>;
}
