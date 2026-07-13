/**
 * Conservative detection of explicit, opposite directives over the same target.
 *
 * This is intentionally narrower than sentiment or general contradiction
 * detection. It protects identity/merge heuristics from erasing rules such as
 * "enable audit logs" and "disable audit logs", while leaving unrelated or
 * compound instructions to the normal lexical checks.
 */

type Sign = -1 | 1;

interface DirectiveFamily {
	positive: ReadonlySet<string>;
	negative: ReadonlySet<string>;
}

function words(values: string[]): ReadonlySet<string> {
	return new Set(values);
}

const DIRECTIVE_FAMILIES: readonly DirectiveFamily[] = [
	{
		positive: words(["enable", "enables", "enabled", "enabling", "activate", "activates", "activated", "activating"]),
		negative: words(["disable", "disables", "disabled", "disabling", "deactivate", "deactivates", "deactivated", "deactivating"]),
	},
	{
		positive: words(["allow", "allows", "allowed", "allowing", "permit", "permits", "permitted", "permitting"]),
		negative: words(["disallow", "disallows", "disallowed", "disallowing", "forbid", "forbids", "forbidden", "forbidding", "prohibit", "prohibits", "prohibited", "prohibiting"]),
	},
	{
		positive: words(["include", "includes", "included", "including", "add", "adds", "added", "adding"]),
		negative: words(["exclude", "excludes", "excluded", "excluding", "remove", "removes", "removed", "removing"]),
	},
	{
		positive: words(["keep", "keeps", "kept", "keeping", "retain", "retains", "retained", "retaining", "preserve", "preserves", "preserved", "preserving"]),
		negative: words(["remove", "removes", "removed", "removing", "delete", "deletes", "deleted", "deleting", "discard", "discards", "discarded", "discarding", "drop", "drops", "dropped", "dropping"]),
	},
	{
		positive: words(["show", "shows", "showed", "shown", "showing", "display", "displays", "displayed", "displaying"]),
		negative: words(["hide", "hides", "hid", "hidden", "hiding", "conceal", "conceals", "concealed", "concealing"]),
	},
	{
		positive: words(["install", "installs", "installed", "installing"]),
		negative: words(["uninstall", "uninstalls", "uninstalled", "uninstalling"]),
	},
	{
		positive: words(["accept", "accepts", "accepted", "accepting"]),
		negative: words(["reject", "rejects", "rejected", "rejecting"]),
	},
	{
		positive: words(["start", "starts", "started", "starting"]),
		negative: words(["stop", "stops", "stopped", "stopping"]),
	},
	{
		positive: words(["require", "requires", "required", "requiring", "mandate", "mandates", "mandated", "mandating"]),
		negative: words([]),
	},
];

const NEGATIONS = new Set([
	"not",
	"never",
	"no",
	"don't",
	"dont",
	"cannot",
	"can't",
	"cant",
	"won't",
	"wont",
	"without",
	"avoid",
	"avoids",
	"avoided",
	"avoiding",
]);

const TARGET_STOP = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"always",
	"be",
	"because",
	"been",
	"being",
	"but",
	"by",
	"can",
	"could",
	"did",
	"do",
	"does",
	"for",
	"from",
	"generally",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"may",
	"might",
	"must",
	"normally",
	"of",
	"on",
	"only",
	"or",
	"please",
	"prefer",
	"prefers",
	"rather",
	"typically",
	"rule",
	"should",
	"than",
	"that",
	"the",
	"their",
	"them",
	"they",
	"this",
	"to",
	"use",
	"uses",
	"using",
	"via",
	"want",
	"wants",
	"was",
	"we",
	"were",
	"with",
	"would",
	"you",
	"usually",
]);

const DIRECTIVE_WORDS = new Set(
	DIRECTIVE_FAMILIES.flatMap((family) => [
		...family.positive,
		...family.negative,
	]),
);

function tokenize(value: string): string[] {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replace(/[\u2018\u2019]/g, "'")
		.match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) ?? [];
}

function negated(tokens: string[], index: number): boolean {
	const start = Math.max(0, index - 3);
	for (let cursor = start; cursor < index; cursor += 1) {
		const token = tokens[cursor]!;
		if (!NEGATIONS.has(token)) continue;
		// "not only include" is additive rather than negative.
		if (token === "not" && tokens[cursor + 1] === "only") continue;
		return true;
	}
	return false;
}

function familySign(tokens: string[], family: DirectiveFamily): Sign | undefined {
	const signs = new Set<Sign>();
	for (const [index, token] of tokens.entries()) {
		let sign: Sign | undefined;
		if (family.positive.has(token)) sign = 1;
		else if (family.negative.has(token)) sign = -1;
		if (!sign) continue;
		if (negated(tokens, index)) sign = sign === 1 ? -1 : 1;
		signs.add(sign);
	}

	// A compound rule containing both directions needs clause-level parsing;
	// fail open here rather than broadly declaring it contradictory.
	return signs.size === 1 ? [...signs][0] : undefined;
}

function stemTarget(token: string): string {
	let stem = token;
	if (stem.length > 5 && stem.endsWith("ing")) stem = stem.slice(0, -3);
	else if (stem.length > 4 && stem.endsWith("ed")) stem = stem.slice(0, -2);
	else if (stem.length > 3 && stem.endsWith("s")) stem = stem.slice(0, -1);
	if (stem.length > 3 && stem.at(-1) === stem.at(-2)) stem = stem.slice(0, -1);
	return stem;
}

function targetTerms(tokens: string[]): Set<string> {
	const out = new Set<string>();
	for (const [index, token] of tokens.entries()) {
		if (DIRECTIVE_WORDS.has(token) || NEGATIONS.has(token) || TARGET_STOP.has(token)) continue;
		if ((token === "turn" || token === "turns" || token === "turned" || token === "turning") && /^(?:on|off)$/.test(tokens[index + 1] ?? "")) continue;
		if (/^(?:on|off)$/.test(token) && /^(?:turn|turns|turned|turning)$/.test(tokens[index - 1] ?? "")) continue;
		if (token.length > 2) out.add(stemTarget(token));
	}
	return out;
}

function sameTarget(left: string[], right: string[]): boolean {
	const a = targetTerms(left);
	const b = targetTerms(right);
	if (a.size === 0 || b.size === 0) return false;
	let overlap = 0;
	for (const term of a) if (b.has(term)) overlap += 1;
	return overlap > 0 && overlap / Math.max(a.size, b.size) >= 0.6;
}

function turnSign(tokens: string[]): Sign | undefined {
	const signs = new Set<Sign>();
	for (let index = 0; index < tokens.length - 1; index += 1) {
		if (!/^(?:turn|turns|turned|turning)$/.test(tokens[index]!)) continue;
		const direction = tokens[index + 1];
		if (direction !== "on" && direction !== "off") continue;
		let sign: Sign = direction === "on" ? 1 : -1;
		if (negated(tokens, index)) sign = sign === 1 ? -1 : 1;
		signs.add(sign);
	}
	return signs.size === 1 ? [...signs][0] : undefined;
}

function hasGenericNegation(tokens: string[]): boolean {
	return tokens.some((token, index) => {
		if (!NEGATIONS.has(token)) return false;
		return !(token === "not" && tokens[index + 1] === "only");
	});
}

/** True only for explicit opposite directives over substantially the same target. */
export function explicitDirectiveConflict(left: string, right: string): boolean {
	const leftTokens = tokenize(left);
	const rightTokens = tokenize(right);
	if (!sameTarget(leftTokens, rightTokens)) return false;

	let comparableDirective = false;
	for (const family of DIRECTIVE_FAMILIES) {
		const leftSign = familySign(leftTokens, family);
		const rightSign = familySign(rightTokens, family);
		if (!leftSign || !rightSign) continue;
		comparableDirective = true;
		if (leftSign !== rightSign) return true;
	}

	const leftTurn = turnSign(leftTokens);
	const rightTurn = turnSign(rightTokens);
	if (leftTurn && rightTurn) {
		comparableDirective = true;
		if (leftTurn !== rightTurn) return true;
	}

	// Once paired directives agree ("never disable" vs "enable"), a generic
	// negation must not reverse that clause-level result. Otherwise, matching
	// predicates with exactly one explicit negation are opposite propositions:
	// "always encrypt" vs "never encrypt", or "encrypt" vs "do not encrypt".
	return !comparableDirective && hasGenericNegation(leftTokens) !== hasGenericNegation(rightTokens);
}
