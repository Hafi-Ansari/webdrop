import { randomInt } from "node:crypto";

// Same playful "rogue" theme as the original Web-Drop list, minus words that
// punch down (homeless, impoverished, incarcerated, ...).
const adjectives = [
  "Brazen", "Clumsy", "Cunning", "Curious", "Cynical", "Daring", "Defiant", "Devious", "Doubtful", "Elusive",
  "Exiled", "Fanatical", "Feral", "Foolish", "Fugitive", "Grumpy", "Heretical", "Lawless", "Mischievous", "Mysterious",
  "Nomadic", "Provocative", "Rebellious", "Reckless", "Restless", "Roaming", "Rowdy", "Ruthless", "Secluded", "Shadowy",
  "Sly", "Sneaky", "Unpredictable", "Untamed", "Wandering", "Wicked", "Wily",
];

const nouns = [
  "Agitator", "Bandit", "Buccaneer", "Castaway", "Corsair", "Cynic", "Deserter", "Drifter", "Heretic", "Hooligan",
  "Maverick", "Miscreant", "Nihilist", "Nomad", "Outcast", "Outlaw", "Pessimist", "Pirate", "Prowler", "Raider",
  "Rascal", "Rebel", "Recluse", "Renegade", "Rogue", "Scoundrel", "Skeptic", "Smuggler", "Trickster", "Vagabond",
  "Wanderer", "Zealot",
];

const pick = <T>(list: readonly T[]): T => list[randomInt(list.length)] as T;

/** Random "Adjective Noun", avoiding names in `taken` when possible. */
export function randomName(taken: ReadonlySet<string> = new Set()): string {
  for (let i = 0; i < 16; i++) {
    const name = `${pick(adjectives)} ${pick(nouns)}`;
    if (!taken.has(name)) return name;
  }
  // Extremely crowded room: fall back to a numeric suffix.
  for (;;) {
    const name = `${pick(adjectives)} ${pick(nouns)} ${randomInt(2, 1000)}`;
    if (!taken.has(name)) return name;
  }
}

export const nameWords = { adjectives, nouns };
