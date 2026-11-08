import type { DeckCardItem } from '../types';

export interface ParsedDeckResult {
  deckName: string;
  cards: DeckCardItem[];
  rawText: string;
}

/**
 * Parses raw text decklists from Moxfield, Archidekt, MTGGoldfish, TappedOut, MTG Arena, etc.
 * Handles rich formats including set codes, collector numbers, foil tags, categories, and custom labels.
 */
export function parseDecklistText(rawText: string, defaultDeckName = 'Imported Deck'): ParsedDeckResult {
  const lines = rawText.split(/\r?\n/);
  const cardMap = new Map<string, DeckCardItem>();
  let currentSection: 'commander' | 'mainboard' | 'sideboard' | 'companion' | 'other' = 'mainboard';
  let detectedDeckName = defaultDeckName;

  // Pattern for quantity prefix e.g. "1 Sol Ring", "1x Sol Ring", "  4x Lightning Bolt"
  const linePattern = /^\s*(\d+)x?\s+(.+)$/i;

  for (let rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    // Check for comments or section headers (but not card lines that happen to end with ':')
    const isCardLine = linePattern.test(line);
    if (!isCardLine && (line.startsWith('//') || line.startsWith('#') || (line.startsWith('[') && line.endsWith(']')) || line.endsWith(':'))) {
      const lower = line.toLowerCase();
      if (lower.includes('commander') || lower.includes('commanders')) {
        currentSection = 'commander';
      } else if (lower.includes('companion') || lower.includes('companions')) {
        currentSection = 'companion';
      } else if (lower.includes('sideboard') || lower.includes('side board')) {
        currentSection = 'sideboard';
      } else if (lower.includes('mainboard') || lower.includes('main') || lower.includes('deck')) {
        currentSection = 'mainboard';
      } else if (lower.startsWith('// name:') || lower.startsWith('# name:')) {
        const parts = line.split(':');
        if (parts[1]?.trim()) {
          detectedDeckName = parts[1].trim();
        }
      }
      continue;
    }

    // Check for sections without punctuation, like "Sideboard" or "Commander"
    const lowerLine = line.toLowerCase();
    if (lowerLine === 'commander' || lowerLine === 'commanders') {
      currentSection = 'commander';
      continue;
    }
    if (lowerLine === 'companion' || lowerLine === 'companions') {
      currentSection = 'companion';
      continue;
    }
    if (lowerLine === 'sideboard') {
      currentSection = 'sideboard';
      continue;
    }
    if (lowerLine === 'deck' || lowerLine === 'mainboard') {
      currentSection = 'mainboard';
      continue;
    }

    let count = 1;
    let cardPart = line;

    const match = line.match(linePattern);
    if (match) {
      count = parseInt(match[1], 10) || 1;
      cardPart = match[2].trim();
    }

    // Check bracketed categories in line (e.g. Archidekt "[Commander]", "[Sideboard]")
    let lineSection = currentSection;
    const bracketMatches = cardPart.match(/\[[^\]]*\]/g) || [];
    for (const b of bracketMatches) {
      const lower = b.toLowerCase();
      if (lower.includes('commander')) {
        lineSection = 'commander';
      } else if (lower.includes('companion')) {
        lineSection = 'companion';
      } else if (lower.includes('sideboard')) {
        lineSection = 'sideboard';
      }
    }

    // Remove Archidekt caret color / hex tags: e.g. ^Ramp,#ff0000^
    cardPart = cardPart.replace(/\^[^^]*\^/g, ' ');

    // Detect foil tags
    let isFoil = false;
    if (/\*f\*|\[foil\]|\(foil\)/i.test(cardPart)) {
      isFoil = true;
    }
    // Remove all asterisk tags: e.g. *F*, *E*, *Etched*
    cardPart = cardPart.replace(/\*[^*]+\*/g, ' ');

    // Remove finish annotations in parentheses: (Foil), (Etched), (Nonfoil), etc.
    cardPart = cardPart.replace(/\((?:foil|etched|nonfoil|f|e|showcase|extended art|borderless|retro frame)\)/gi, ' ');

    let setCode: string | undefined;
    let collectorNumber: string | undefined;

    // Pattern 1: (SET:CN) or [SET:CN] e.g. (CMM:402), (plst:TMP-315)
    const colonMatch = cardPart.match(/[\[\(]([a-zA-Z0-9]{2,6})\s*:\s*([a-zA-Z0-9★*\-\.\/]+)[\]\)]/);
    if (colonMatch) {
      setCode = colonMatch[1].toLowerCase();
      collectorNumber = colonMatch[2];
      cardPart = cardPart.replace(colonMatch[0], ' ');
    }

    // Pattern 2: (SET) CN or [SET] CN or (SET) e.g. (CMM) 402, (plst) TMP-315
    const setNumMatch = cardPart.match(/[\[\(]([a-zA-Z0-9]{2,6})[\]\)]\s*([a-zA-Z0-9★*\-\.\/]+)?/);
    if (setNumMatch) {
      setCode = setCode || setNumMatch[1].toLowerCase();
      if (setNumMatch[2]) collectorNumber = collectorNumber || setNumMatch[2];
      cardPart = cardPart.replace(setNumMatch[0], ' ');
    }

    // Pattern 3: Full set name in parentheses e.g. (Commander Masters) 402
    const fullSetMatch = cardPart.match(/\([^\)]+\)\s*([a-zA-Z0-9★*\-\.\/]+)?/);
    if (fullSetMatch) {
      if (fullSetMatch[1]) collectorNumber = collectorNumber || fullSetMatch[1];
      cardPart = cardPart.replace(fullSetMatch[0], ' ');
    }

    // Remove remaining bracketed categories/tags e.g. [Ramp], [Category: Draw]
    cardPart = cardPart.replace(/\[[^\]]*\]/g, ' ');

    // Remove hashtag tags or trailing collector numbers: e.g. TMP-315, -315, #402
    cardPart = cardPart.replace(/\s+[a-zA-Z0-9★*]*[-–—][a-zA-Z0-9★*]+\s*$/, ' ');
    cardPart = cardPart.replace(/\s*[-–—]\s*\d+[a-zA-Z★*]*\s*$/, ' ');
    cardPart = cardPart.replace(/#\d+[a-zA-Z★*]*/g, ' ');
    cardPart = cardPart.replace(/#.*$/, ' ');
    cardPart = cardPart.replace(/\s+\d+[a-zA-Z★*]*\s*$/, ' ');

    // Clean up trailing comments
    cardPart = cardPart.replace(/\/\/.*$/, ' ');

    // Moxfield double faced cards as "1 Tony Stark / The Invincible Iron Man (MSH) 80"
    // Just get the left half before the /
    if (cardPart.includes('/')) {
      cardPart = cardPart.split('/')[0].trim();
    }

    // Clean and normalize card name
    const cleanedName = cleanCardName(cardPart);
    if (!cleanedName) continue;

    const key = `${cleanedName.toLowerCase()}::${lineSection}`;
    if (cardMap.has(key)) {
      const existing = cardMap.get(key)!;
      existing.targetCount += count;
    } else {
      cardMap.set(key, {
        id: `${cleanedName.toLowerCase()}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        name: cleanedName,
        rawName: cardPart,
        targetCount: count,
        verifiedCount: 0,
        section: lineSection,
        setCode,
        collectorNumber,
        isFoil
      });
    }
  }

  return {
    deckName: detectedDeckName,
    cards: Array.from(cardMap.values()),
    rawText
  };
}

/**
 * Normalizes card names, stripping unnecessary quotes and whitespace.
 */
export function cleanCardName(name: string): string {
  let cleaned = name.replace(/\s+/g, ' ').trim();
  // Strip enclosing quotes
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  // Moxfield double faced cards as "Tony Stark / The Invincible Iron Man" -> left half before the /
  if (cleaned.includes('/')) {
    cleaned = cleaned.split('/')[0].trim();
  }
  // Remove any trailing collector numbers/hyphens e.g. -315
  cleaned = cleaned.replace(/\s*[-–—]\s*\d+[a-zA-Z★*]*$/, '').trim();
  return cleaned;
}
