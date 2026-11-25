import {useEffect, useState} from 'react';

// A question an extension asked through Pi's dialogs, such as ask_user_question: shown above the message box
// while the run waits, answered by tapping an option, Yes or No, or typing.

export type PendingQuestion = {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  at: number;
};
type Api = (url: string, body?: unknown) => Promise<any>;

export function QuestionCard(props: {threadId: string; question: PendingQuestion; api: Api; report: (e: any) => void}) {
  const {question} = props;
  const [text, setText] = useState(question.prefill ?? '');
  const [sending, setSending] = useState(false);
  useEffect(() => setText(question.prefill ?? ''), [question.id]);
  const send = async (reply: {value?: string; confirmed?: boolean; skip?: boolean}) => {
    setSending(true);
    try {
      await props.api(`/threads/${props.threadId}/question`, {question: question.id, ...reply});
    } catch (e) {
      props.report(e);
      setSending(false);
    }
  };
  return (
    <section className="question-card" role="group" aria-label="Question from the agent">
      <span className="question-eyebrow">The agent is asking</span>
      <p className="question-title">{question.title}</p>
      {question.message && <p className="question-message">{question.message}</p>}
      {question.method === 'select' ? (
        <div className="question-options">
          {(question.options ?? []).map(option => (
            <button key={option} disabled={sending} onClick={() => void send({value: option})}>
              {option}
            </button>
          ))}
        </div>
      ) : question.method === 'confirm' ? (
        <div className="question-buttons">
          <button className="primary" disabled={sending} onClick={() => void send({confirmed: true})}>
            Yes
          </button>
          <button disabled={sending} onClick={() => void send({confirmed: false})}>
            No
          </button>
        </div>
      ) : (
        <form
          className="question-form"
          onSubmit={event => {
            event.preventDefault();
            void send({value: text});
          }}
        >
          <textarea
            rows={question.method === 'editor' ? 6 : 2}
            value={text}
            placeholder={question.placeholder ?? 'Type your answer'}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && question.method === 'input') {
                event.preventDefault();
                void send({value: text});
              }
            }}
            autoFocus
          />
          <button className="primary" disabled={sending}>
            Send answer
          </button>
        </form>
      )}
      <button className="quiet question-skip" disabled={sending} onClick={() => void send({skip: true})}>
        Skip this question
      </button>
    </section>
  );
}
