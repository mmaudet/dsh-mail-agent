/**
 * Reading the signature rather than storing a copy of it.
 *
 * The cases here are the owner's real one: an empty `textSignature`, an
 * `htmlSignature` carrying everything, and a separator written without the
 * trailing space the RFC asks for.
 */

import { describe, expect, it } from 'vitest';

import { htmlToText, signatureOf, withSignature, withoutClosing, SEPARATOR } from './signature.js';

const REAL =
  '\n<p>Très cordialement,<br></p><p>--</p><p>Michel-Marie MAUDET</p>' +
  '<p>Directeur Général du Groupe LINAGORA</p><p>Villa Good Tech</p>' +
  '<p>37 rue Pierre Poli</p><p>92130 ISSY LES MOULINEAUX</p>' +
  '<p>+33(0)1 46 96 63 63 / +33(0)6 60 46 98 52</p><p><br></p>';

describe('the markup a mail client stores becomes plain text', () => {
  it('turns paragraphs and breaks into lines', () => {
    expect(htmlToText(REAL)).toBe(
      'Très cordialement,\n\n--\nMichel-Marie MAUDET\nDirecteur Général du Groupe LINAGORA\n' +
        'Villa Good Tech\n37 rue Pierre Poli\n92130 ISSY LES MOULINEAUX\n' +
        '+33(0)1 46 96 63 63 / +33(0)6 60 46 98 52',
    );
  });

  it('decodes the entities a signature actually contains', () => {
    expect(htmlToText('<p>Tel&nbsp;: +33&#40;0&#41;1</p><p>R&amp;D</p>')).toBe('Tel : +33(0)1\nR&D');
  });

  it('does not leave a tag behind', () => {
    expect(htmlToText('<div style="color:red"><span>Nom</span><img src="x"></div>')).not.toMatch(/[<>]/);
  });

  it('answers empty for empty markup', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText('<p><br></p>')).toBe('');
  });
});

describe('which of the two signatures is used', () => {
  it('prefers the plain-text one the owner typed', () => {
    const signature = signatureOf({ textSignature: '-- \nMoi\n06 00 00 00 00', htmlSignature: REAL });
    expect(signature).toContain('06 00 00 00 00');
    expect(signature).not.toContain('LINAGORA');
  });

  it('derives from the markup when the plain-text one is empty', () => {
    // This account's own state: textSignature "" and everything in the HTML.
    expect(signatureOf({ textSignature: '', htmlSignature: REAL })).toContain('Villa Good Tech');
  });

  it('reports none rather than an empty block', () => {
    expect(signatureOf({ textSignature: '', htmlSignature: '' })).toBe(null);
    expect(signatureOf({})).toBe(null);
  });
});

describe('the block starts at the name, not at a closing', () => {
  it('drops the closing the stored signature opens with', () => {
    // Left in, a draft reads "…Michel-Marie / Très cordialement, / -- /
    // Michel-Marie MAUDET": a closing after the name, which nobody writes.
    // The owner's own sent mail has the closing above the separator and the
    // block starting at their name.
    const signature = signatureOf({ htmlSignature: REAL }) ?? '';
    expect(signature).not.toContain('Très cordialement');
    expect(signature).toContain('Michel-Marie MAUDET');
  });

  it('drops the ones people actually write', () => {
    for (const closing of ['Cordialement,', 'Bien à vous,', 'Bien à toi', 'Best regards,', 'Cdt']) {
      expect(withoutClosing(`${closing}\nMoi\n06 00 00 00 00`)).toBe('Moi\n06 00 00 00 00');
    }
  });

  it('keeps a name that merely looks like one', () => {
    expect(withoutClosing('Regards Consulting SARL\n01 02 03')).toBe('Regards Consulting SARL\n01 02 03');
  });

  it('reports none when the closing was the whole signature', () => {
    expect(signatureOf({ textSignature: 'Cordialement,' })).toBe(null);
  });
});

describe('the separator is the one clients fold at', () => {
  it('repairs a bare -- into the RFC 3676 form', () => {
    // Written without the trailing space, a client reads it as ordinary text
    // and quotes the whole block back on every reply in the thread.
    const signature = signatureOf({ htmlSignature: REAL }) ?? '';
    expect(signature.split('\n')).toContain(SEPARATOR);
    expect(signature.split('\n')).not.toContain('--');
  });

  it('adds one when the signature carries none', () => {
    const signature = signatureOf({ textSignature: 'Michel-Marie\n06 00 00 00 00' }) ?? '';
    expect(signature.startsWith(`${SEPARATOR}\n`)).toBe(true);
  });
});

describe('it goes under the reply and nowhere else', () => {
  it('leaves the reply untouched', () => {
    const reply = 'Bonjour,\n\nC’est noté.';
    expect(withSignature(reply, '-- \nMoi')).toBe('Bonjour,\n\nC’est noté.\n\n-- \nMoi');
  });

  it('changes nothing when there is no signature', () => {
    expect(withSignature('Bonjour.\n\n', null)).toBe('Bonjour.');
  });
});
