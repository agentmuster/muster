export type DictationState = {
  phase: 'idle' | 'starting' | 'listening' | 'stopping';
  interim: string;
  error: string;
};

// Web Speech is still vendor-prefixed in some browsers and absent from TypeScript's DOM declarations.
type Result = {isFinal: boolean; 0: {transcript: string}};
export type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: {resultIndex: number; results: ArrayLike<Result>}) => void) | null;
  onerror: ((event: {error: string}) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
export type RecognitionConstructor = new () => Recognition;

export function recognitionConstructor(): RecognitionConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  const browser = window as unknown as {SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor};
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone or speech access was denied. Allow it in your browser settings, or use your keyboard microphone.',
  'service-not-allowed': 'The browser speech service is unavailable. Try your keyboard microphone instead.',
  'audio-capture': 'No microphone is available. Check that another app is not using it.',
  'no-speech': 'No speech detected. Tap the microphone to try again.',
  network: 'The browser speech service could not connect. Check your connection or use your keyboard microphone.',
  'language-not-supported': 'The browser cannot transcribe your selected language. Try your keyboard microphone.',
};

/** Owns one recognition session. Only final text goes into the draft; partial text stays separate. */
export class Dictation {
  state: DictationState = {phase: 'idle', interim: '', error: ''};
  private active?: Recognition;
  private disposed = false;

  constructor(
    private Constructor: RecognitionConstructor | undefined,
    private append: (text: string) => void,
    private changed: (state: DictationState) => void,
    private language = 'en-US',
  ) {}

  private update(change: Partial<DictationState>) {
    this.state = {...this.state, ...change};
    if (!this.disposed) this.changed(this.state);
  }

  start() {
    if (this.active || this.disposed) return;
    if (!this.Constructor) {
      this.update({error: 'Voice typing is not supported in this browser. Use your keyboard microphone instead.'});
      return;
    }
    let recognition: Recognition;
    try {
      recognition = new this.Constructor();
    } catch {
      this.update({error: 'The browser could not start voice typing. Try your keyboard microphone instead.'});
      return;
    }
    this.active = recognition;
    const current = () => !this.disposed && this.active === recognition;
    const committed = new Set<number>();
    recognition.lang = this.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => {
      if (current()) this.update({phase: this.state.phase === 'stopping' ? 'stopping' : 'listening'});
    };
    recognition.onresult = event => {
      if (!current()) return;
      const final: string[] = [];
      const interim: string[] = [];
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript?.trim();
        if (!text) continue;
        if (result.isFinal) {
          if (!committed.has(i)) {
            committed.add(i);
            final.push(text);
          }
        } else {
          interim.push(text);
        }
      }
      if (final.length) this.append(final.join(' '));
      this.update({interim: interim.join(' ')});
    };
    recognition.onerror = event => {
      if (!current()) return;
      const error = event.error === 'aborted' ? '' : ERRORS[event.error] || 'Voice typing failed. You can still type your message.';
      this.cancel(error);
    };
    recognition.onend = () => {
      if (!current()) return;
      this.active = undefined;
      this.update({phase: 'idle', interim: ''});
    };
    this.update({phase: 'starting', interim: '', error: ''});
    try {
      recognition.start();
    } catch {
      this.cancel('The browser could not start voice typing. Check microphone permission and try again.');
    }
  }

  stop() {
    if (!this.active || this.state.phase === 'stopping') return;
    this.update({phase: 'stopping'});
    try {
      // stop allows the browser to deliver its final words before onend. Sending stays disabled until then.
      this.active.stop();
    } catch {
      this.cancel();
    }
  }

  /** Hiding the page or leaving the thread releases the microphone and ignores any late callbacks. */
  cancel(error = '') {
    const recognition = this.active;
    this.active = undefined;
    if (recognition) {
      recognition.onstart = recognition.onresult = recognition.onend = recognition.onerror = null;
      try {
        recognition.abort();
      } catch {
        // Already ended.
      }
    }
    this.update({phase: 'idle', interim: '', error});
  }

  dispose() {
    this.disposed = true;
    this.cancel();
  }
}

/** Append recognized words without replacing the draft the person is already typing. */
export function appendDictation(draft: string, words: string) {
  if (!words.trim()) return draft;
  return draft + (draft && !/\s$/.test(draft) ? ' ' : '') + words.trim();
}
