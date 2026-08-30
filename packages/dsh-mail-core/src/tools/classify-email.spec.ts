/**
 * What `classify_email` knows when it runs, and where it gets it.
 *
 * The cascade's own behaviour is tested in `cascade-loop.spec.ts`. What is
 * tested here is the seam between a mounted plugin and a store: three of the
 * seven nodes need state that changes between messages, and capturing it at
 * mount would make the store a slower copy of the profile.
 */

import { describe, expect, it } from "vitest";

import type { CascadeContext, RoutingRule } from "../cascade/types.js";
import type { MailMessage } from "../types.js";
import { contextFor } from "./classify-email.js";

describe("the context is composed per message, not captured at mount", () => {
  const base: CascadeContext = {
    owner: "owner@example.org",
    vipSenders: [],
    corporateDomains: [],
    statedRoutes: [],
    threadCategory: null,
    learnedPatterns: [],
  };
  const message = (over: Partial<MailMessage> = {}): MailMessage => ({
    id: "m1",
    threadId: null,
    messageId: "m1@example.org",
    inReplyTo: [],
    references: [],
    from: [{ name: null, email: "a@example.org" }],
    to: [],
    cc: [],
    subject: "s",
    receivedAt: new Date(),
    sentAt: new Date(),
    keywords: [],
    folder: "INBOX",
    preview: "",
    bodyText: null,
    bodyHtml: null,
    hasAttachments: false,
    spamHeaders: {},
    listUnsubscribe: [],
    listId: null,
    ...over,
  });

  it("leaves the three live fields empty when nothing supplies them", () => {
    // Which is what nodes 1, 2b and 3 saw before a store was wired: they had
    // nothing and declined, unconditionally, in production.
    const got = contextFor(message(), { context: base, model: null });
    expect(got).toStrictEqual(base);
  });

  it("reads the routes on every call, so a runtime edit takes effect", () => {
    let routes: RoutingRule[] = [];
    const state = {
      loadRoutes: () => routes,
      loadPatterns: () => [],
      threadCategory: () => null,
    };

    expect(contextFor(message(), { context: base, model: null, state }).statedRoutes).toStrictEqual(
      [],
    );
    // The owner adds one without restarting anything.
    routes = [{ listId: null, sender: "a@example.org", category: "spam-formulaire-contact" }];
    expect(contextFor(message(), { context: base, model: null, state }).statedRoutes).toStrictEqual(
      routes,
    );
  });

  it("asks for the thread only when the message has one", () => {
    const asked: string[] = [];
    const state = {
      loadRoutes: () => [],
      loadPatterns: () => [],
      threadCategory: (id: string) => {
        asked.push(id);
        return "demande-interne" as const;
      },
    };

    expect(contextFor(message(), { context: base, model: null, state }).threadCategory).toBeNull();
    expect(asked).toStrictEqual([]);

    const withThread = contextFor(message({ threadId: "t1" }), {
      context: base,
      model: null,
      state,
    });
    expect(withThread.threadCategory).toBe("demande-interne");
    expect(asked).toStrictEqual(["t1"]);
  });
});
