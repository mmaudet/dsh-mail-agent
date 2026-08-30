/**
 * Node 6, without a gateway.
 *
 * Two things are worth testing here and they are not the model's competence:
 * what leaves the perimeter, and what is accepted back. The first is a privacy
 * property, the second is what stops a broken prompt from reading as an
 * uncertain mailbox.
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import { CORPUS } from '../fixtures/corpus.js';
import type { MailMessage } from '../types.js';
import {
  MAX_BODY_CHARS,
  SYSTEM_PROMPT,
  createLlmClassifier,
  parseVerdict,
  renderMessage,
  type LlmStreamer,
} from './llm-classifier.js';
import type { CascadeContext } from './types.js';

const CONTEXT: CascadeContext = {
  owner: 'owner@example.org',
  vipSenders: [],
  corporateDomains: [],
  threadCategory: null,
  statedRoutes: [],
  learnedPatterns: [],
};

const MESSAGE = CORPUS[0]?.message as MailMessage;

/** Replays one answer and records exactly what it was asked. */
function llmAnswering(text: string): LlmStreamer & { readonly asked: GenerateOptions[] } {
  const asked: GenerateOptions[] = [];
  return {
    asked,
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      asked.push(options);
      return (async function* (): AsyncGenerator<StreamChunk> {
        // Split, because a real stream arrives in pieces and a parser that
        // only works on one chunk works only in a test.
        await Promise.resolve();
        yield { type: 'block-start', index: 0, blockType: 'text' };
        for (const piece of text.match(/.{1,7}/gs) ?? []) {
          yield { type: 'text-delta', index: 0, text: piece };
        }
        // Thinking, not the answer.
        yield { type: 'reasoning-delta', index: 0, text: 'ignored' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

describe('what is sent', () => {
  it('asks on the economy route, deterministically', async () => {
    const llm = llmAnswering('{"category":"rapport-compte-rendu-interne","confidence":0.9,"rationale":"r"}');
    await createLlmClassifier({ llm, provider: 'mail-llm-economy', model: 'm' }).classify(
      MESSAGE,
      CONTEXT,
    );

    const [call] = llm.asked;
    expect(call?.provider).toBe('mail-llm-economy');
    // Zero, not the provider default: a calibration measures nothing if the
    // same message classifies differently twice.
    expect(call?.temperature).toBe(0);
    expect(call?.system).toBe(SYSTEM_PROMPT);
  });

  it('sends a bounded excerpt, not a whole message', () => {
    const long = 'x'.repeat(MAX_BODY_CHARS * 3);
    const rendered = renderMessage({ ...MESSAGE, bodyText: long }, CONTEXT);

    // This is the only place message content leaves the perimeter, so how much
    // of it does is a reviewable number rather than an accident.
    expect(rendered.length).toBeLessThan(MAX_BODY_CHARS + 600);
    expect(rendered).not.toContain('x'.repeat(MAX_BODY_CHARS + 1));
  });

  it('falls back to the preview when there is no text body', () => {
    const rendered = renderMessage(
      { ...MESSAGE, bodyText: null, preview: 'the preview line' },
      CONTEXT,
    );
    expect(rendered).toContain('the preview line');
  });
});

describe('what is accepted back', () => {
  it('reads a well-formed answer', () => {
    expect(
      parseVerdict('{"category":"veille-newsletter","confidence":0.82,"rationale":"bulk sender"}'),
    ).toStrictEqual({ category: 'veille-newsletter', confidence: 0.82, rationale: 'bulk sender' });
  });

  it('finds the object a model wrapped in prose or a fence', () => {
    const wrapped = 'Sure!\n```json\n{"category":"rapport-compte-rendu-interne","confidence":0.5,"rationale":"r"}\n```';
    expect(parseVerdict(wrapped).category).toBe('rapport-compte-rendu-interne');
  });

  it('rejects a category outside the vocabulary', () => {
    // Accepting it would put a value in a trace and a keyword that nothing
    // downstream knows how to act on.
    expect(() => parseVerdict('{"category":"urgent","confidence":0.9}')).toThrow(/unknown category/);
  });

  it('refuses to let the model answer needs-review', () => {
    // That is node 7's to assign, from a confidence the model reports. A model
    // allowed to answer it directly can bypass the threshold entirely.
    expect(() => parseVerdict('{"category":"needs-review","confidence":0.9}')).toThrow(
      /may not answer needs-review/,
    );
  });

  it('rejects a missing or non-numeric confidence', () => {
    expect(() => parseVerdict('{"category":"rapport-compte-rendu-interne"}')).toThrow(/numeric confidence/);
    expect(() => parseVerdict('{"category":"rapport-compte-rendu-interne","confidence":"high"}')).toThrow(
      /numeric confidence/,
    );
  });

  it('rejects prose, rather than reading it as uncertainty', () => {
    // A broken prompt must look like a broken prompt. Degrading it to a
    // low-confidence answer would make it look like a hard mailbox.
    expect(() => parseVerdict('I think this is a newsletter.')).toThrow(/no JSON object/);
    expect(() => parseVerdict('{"category": }')).toThrow(/malformed JSON/);
  });

  it('clamps a confidence the model put outside the range', () => {
    expect(parseVerdict('{"category":"rapport-compte-rendu-interne","confidence":4}').confidence).toBe(1);
    expect(parseVerdict('{"category":"rapport-compte-rendu-interne","confidence":-2}').confidence).toBe(0);
  });

  it('bounds the rationale, which is exported', () => {
    const long = 'y'.repeat(500);
    expect(parseVerdict(`{"category":"rapport-compte-rendu-interne","confidence":1,"rationale":"${long}"}`).rationale
      .length).toBeLessThanOrEqual(160);
  });
});

describe('assembling the stream', () => {
  it('reassembles text deltas and ignores everything else', async () => {
    const llm = llmAnswering('{"category":"demande-interne","confidence":0.95,"rationale":"asks a question"}');
    const verdict = await createLlmClassifier({ llm, provider: 'p', model: 'm' }).classify(
      MESSAGE,
      CONTEXT,
    );

    // Reasoning deltas are not the answer, and a parser that swallowed them
    // would read a model's thinking as its verdict.
    expect(verdict).toStrictEqual({
      category: 'demande-interne',
      confidence: 0.95,
      rationale: 'asks a question',
    });
  });
});
