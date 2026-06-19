"""Generate a synthetic Claude + ChatGPT export so the pipeline runs out of the
box — no personal data required.

Writes two files into a sample directory (default ``../sample``):

    conversations-claude.json    # Claude export shape  (flat ``chat_messages``)
    conversations-chatgpt.json   # ChatGPT export shape (``mapping`` node-tree)

Both match the real export schemas closely enough that ``normalize.py`` parses
them identically to a genuine export.

The text is invented but built by filling templated question frames with varied
domain nouns, so each conversation embeds to a *distinct* point that still
clusters with its theme — producing a fuzzy, realistically dense map rather than
a handful of stacked dots. Topics are weighted unevenly (like real usage) and
message counts follow a long tail (most chats short, a few very long).

    python sample_data.py                 # -> ../sample, default count
    python sample_data.py ../sample 950   # -> ../sample, ~950 conversations
    python sample_data.py /tmp/demo       # -> /tmp/demo

Then build the map from it:

    make map INPUT=../sample
"""
from __future__ import annotations

import json
import os
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone

# Roughly 2/3 the scale of a heavy real account (~1.4k conversations).
DEFAULT_N = 950

# Each topic aligns with a category in taxonomy.py so categorize.py lands every
# conversation in its intended theme. `frames` are templated over `nouns` to
# produce wide intra-topic variety; `replies` populate the transcript view only
# (assistant turns don't affect embedding). `weight` skews the topic mix toward
# what a technical user actually asks about.
TOPICS: dict[str, dict] = {
    "Design & Branding": {
        "weight": 1.3,
        "nouns": [
            "a SaaS dashboard", "a mobile onboarding flow", "a pricing page",
            "a fintech logo", "a design token scale", "a dark-mode palette",
            "an empty-state screen", "a navigation sidebar", "a settings page",
            "a marketing landing page", "a component library", "an icon set",
            "a checkout form", "a data table", "a notification system",
            "a brand style guide",
        ],
        "frames": [
            "How should I structure the visual hierarchy for {x}?",
            "Critique my layout approach for {x}.",
            "What spacing and type scale works for {x}?",
            "I'm redesigning {x} — where do I start?",
            "How do I make {x} feel more polished without a full rebrand?",
            "What's a clean way to handle responsive breakpoints on {x}?",
            "Suggest a color palette and accent strategy for {x}.",
            "How do I improve accessibility on {x}?",
        ],
        "replies": [
            "Establish one clear focal point on {x}, then use size, weight, and whitespace to step the eye through secondary actions.",
            "For {x}, lock a 4- or 8-pt spacing grid and a modular type scale so everything feels intentional.",
            "Reserve your accent color on {x} strictly for primary actions; everything else stays neutral.",
            "On {x}, check contrast ratios, focus states, and hit targets before worrying about polish.",
        ],
    },
    "Art & Illustration": {
        "weight": 0.8,
        "nouns": [
            "an album cover", "a children's book spread", "a character portrait",
            "a watercolor landscape", "a poster design", "a logo mascot",
            "a fantasy map", "a comic panel", "a product hero image",
            "a tattoo concept", "a sticker pack", "a concept-art scene",
            "a pixel-art sprite", "a linocut print", "a gradient illustration",
            "a moodboard",
        ],
        "frames": [
            "Help me write an image prompt for {x}.",
            "How do I improve the composition of {x}?",
            "What color story works for {x}?",
            "Give me three style directions for {x}.",
            "How do I keep a consistent character across {x} and {y}?",
            "What's a good lighting setup for {x}?",
            "Critique the focal point in {x}.",
            "How do I make {x} feel less flat?",
        ],
        "replies": [
            "For {x}, lead the prompt with subject, then style, then lighting and mood, and keep modifiers concrete.",
            "Use the rule of thirds on {x} and let negative space carry the eye to the subject.",
            "Pick a limited palette for {x} — two dominants and one accent — so it reads cohesively.",
            "Add a clear key light and a cooler fill on {x} to give the form depth.",
        ],
    },
    "Music & Audio": {
        "weight": 1.0,
        "nouns": [
            "an indie folk chorus", "a lo-fi beat in A minor", "a synthwave track",
            "a worship ballad", "a vocal mix", "a guitar tone", "a drum pattern",
            "a Suno prompt", "a bassline", "a song bridge", "a podcast intro",
            "a Logic Pro session", "a melody hook", "an ambient pad",
            "a mastering chain", "a string arrangement",
        ],
        "frames": [
            "Help me write {x}.",
            "What chord progression fits {x}?",
            "How do I mix {x} so it sits well?",
            "Give me a prompt for {x}.",
            "My {x} sounds thin — how do I fatten it?",
            "What tempo and feel suits {x}?",
            "How do I arrange {x} so it builds?",
            "Critique the structure of {x}.",
        ],
        "replies": [
            "For {x}, keep the hook melodically higher than the verse and repeat one strong image.",
            "Try a i–VI–III–VII move for {x}; it stays moody but resolves.",
            "Carve mud around 300 Hz on {x} and use gentle parallel compression to keep it present.",
            "Double-track {x}, pan the takes wide, and add a short room reverb to glue them.",
        ],
    },
    "Writing & Stories": {
        "weight": 1.1,
        "nouns": [
            "a short story about a lighthouse keeper", "stiff dialogue",
            "a personal essay about moving cities", "a bedtime story's pacing",
            "a sci-fi opening line", "a character's backstory", "a poem about autumn",
            "a screenplay scene", "a blog post intro", "a newsletter hook",
            "a villain's motivation", "a memoir chapter", "a fairy-tale retelling",
            "a product announcement", "a wedding speech", "a cover letter",
        ],
        "frames": [
            "Help me open {x}.",
            "How do I make {x} less stiff?",
            "Give me feedback on {x}.",
            "What's a strong structure for {x}?",
            "Rewrite {x} to be more vivid.",
            "How do I raise the stakes in {x}?",
            "What's a better ending for {x}?",
            "Tighten {x} without losing the voice.",
        ],
        "replies": [
            "Open {x} in the middle of motion, then break the routine so absence becomes the inciting image.",
            "Cut the throat-clearing in {x} and trust subtext to carry what the characters won't say.",
            "Give {x} a then-and-now spine: anchor a concrete scene, braid in memory, close on what changed.",
            "Replace abstractions in {x} with one specific, sensory detail per beat.",
        ],
    },
    "Faith & Spirituality": {
        "weight": 0.7,
        "nouns": [
            "the prodigal son parable", "Psalm 23", "the resurrection accounts",
            "a sermon on forgiveness", "the beatitudes", "the book of Job",
            "justification and sanctification", "the Lord's Prayer", "Romans 8",
            "the parable of the sower", "the Sermon on the Mount", "Ecclesiastes",
            "a small-group study on grace", "the prophets", "Holy Week", "the psalms of lament",
        ],
        "frames": [
            "What does {x} teach about grace?",
            "Can you explain the historical context of {x}?",
            "How do early church writers interpret {x}?",
            "I'm preparing a study on {x} — where should I anchor it?",
            "What's the main argument of {x}?",
            "How does {x} connect to {y}?",
            "Walk me through {x} verse by verse.",
            "What's a common misreading of {x}?",
        ],
        "replies": [
            "In {x}, grace shows up as unearned — restoration tends to precede any rehearsed confession.",
            "Read {x} in its original setting first; the imagery is doing theological work, not just decoration.",
            "The earliest readers took {x} as concrete and communal, not merely private or symbolic.",
            "Anchor a study of {x} in two or three cross-references so the theme is shown, not just asserted.",
        ],
    },
    "Health & Wellness": {
        "weight": 1.0,
        "nouns": [
            "deep sleep", "desk tension headaches", "vitamin gaps", "protein intake",
            "a beginner strength routine", "recurring lower-back pain", "resting heart rate",
            "screen-time eye strain", "a cutting diet", "magnesium supplements",
            "morning fatigue", "hydration habits", "stress and cortisol",
            "a half-marathon plan", "mobility for stiff hips", "caffeine timing",
        ],
        "frames": [
            "What are evidence-based ways to improve {x}?",
            "I've been struggling with {x} — what might help?",
            "Does {x} actually matter, or is it overhyped?",
            "How do I think about {x} versus {y}?",
            "What's a sensible beginner approach to {x}?",
            "Is my plan for {x} reasonable?",
            "What habits move the needle on {x}?",
            "When should I see a doctor about {x}?",
        ],
        "replies": [
            "For {x}, the boring fundamentals — consistency, light, sleep, movement — beat any single supplement.",
            "Start small with {x}: one repeatable change you can sustain for a few weeks, then reassess.",
            "The evidence on {x} is modest; cover the basics from food and routine before adding anything.",
            "Track {x} for two weeks so you're adjusting from data, not vibes.",
        ],
    },
    "Food & Cooking": {
        "weight": 0.9,
        "nouns": [
            "dense sourdough", "a restaurant-quality sear", "a weeknight chickpea dinner",
            "silky carbonara", "a less bitter French press", "flaky pie crust",
            "a weeknight stir-fry", "homemade pizza dough", "a braised short rib",
            "fluffy pancakes", "a sheet-pan salmon", "caramelized onions",
            "a vinaigrette that emulsifies", "crispy roast potatoes", "a pot of chili", "cold-brew coffee",
        ],
        "frames": [
            "Why does my {x} keep going wrong?",
            "How do I get {x} right at home?",
            "Give me a quick approach to {x}.",
            "What's the trick to {x}?",
            "How do I make {x} ahead of time?",
            "Scale {x} up for a dinner party.",
            "What can I substitute in {x}?",
            "How do I fix {x} that turned out bland?",
        ],
        "replies": [
            "{x} usually comes down to temperature and timing — get those right and technique follows.",
            "Season {x} in layers and taste as you go rather than fixing it all at the end.",
            "For {x}, prep the components separately and combine at the last moment so nothing turns soggy.",
            "Dry surfaces and high heat are the secret to {x} developing real flavor.",
        ],
    },
    "Finance & Legal": {
        "weight": 1.0,
        "nouns": [
            "a Roth IRA versus a 6% car loan", "index fund expense ratios",
            "dollar-cost averaging", "an emergency fund", "capital gains on a stock sale",
            "a rental property's cash flow", "a 401k rollover", "a freelance contract",
            "an LLC versus sole proprietorship", "estimated quarterly taxes",
            "a mortgage refinance", "an HSA", "diversifying a portfolio", "a will and beneficiaries",
            "a startup equity grant", "credit card churning",
        ],
        "frames": [
            "Should I prioritize {x}?",
            "Explain how {x} works in plain terms.",
            "Is {x} actually a good idea for me?",
            "How do I think about {x} versus {y}?",
            "What are the tax implications of {x}?",
            "Walk me through the tradeoffs of {x}.",
            "What questions should I ask before {x}?",
            "How risky is {x}?",
        ],
        "replies": [
            "With {x}, capture any guaranteed return first, then weigh certain gains against uncertain ones.",
            "The mechanics of {x} are simpler than they sound — the cost is usually in fees and time, not complexity.",
            "For {x}, write down your time horizon first; the right answer changes a lot with it.",
            "Run {x} past the boring checklist: liquidity, fees, taxes, and what happens if you're wrong.",
        ],
    },
    "Career & Work": {
        "weight": 1.0,
        "nouns": [
            "a promotion case", "a tough 1:1", "an OKR draft", "a roadmap pitch",
            "a salary negotiation", "a resignation message", "an exec status update",
            "a hiring loop", "a performance review", "a cross-team conflict",
            "a quarterly planning doc", "a stakeholder email", "a postmortem write-up",
            "a career-ladder conversation", "a project kickoff", "a feedback message to a report",
        ],
        "frames": [
            "Help me prepare {x}.",
            "How do I frame {x} without sounding defensive?",
            "What should go into {x}?",
            "Critique my draft of {x}.",
            "How do I handle {x} with a skip-level watching?",
            "Make {x} more concise and direct.",
            "What's the strongest opening for {x}?",
            "How do I push back in {x} while staying collaborative?",
        ],
        "replies": [
            "Lead {x} with the outcome and the ask, then support it — executives read top-down.",
            "Frame {x} around impact and tradeoffs, not effort; decisions hinge on outcomes.",
            "Keep {x} to one screen: context, recommendation, risks, next step.",
            "In {x}, name the shared goal first, then disagree on the path — it stays collaborative.",
        ],
    },
    "Software & Tech": {
        "weight": 1.6,
        "nouns": [
            "debouncing a search input in React", "a messy Python import layout",
            "a tangled git history", "when to add a database index", "containerizing a Flask app",
            "a flaky integration test", "a memory leak in a Node service", "a slow SQL query",
            "structuring a monorepo", "a CORS error", "rate-limiting an API",
            "a TypeScript generic that won't infer", "caching with Redis", "a CI pipeline that's too slow",
            "graceful shutdown in a worker", "a race condition in async code",
        ],
        "frames": [
            "What's the cleanest way to handle {x}?",
            "How do I debug {x}?",
            "I'm stuck on {x} — what am I missing?",
            "What are the tradeoffs around {x}?",
            "Walk me through fixing {x}.",
            "Is there a simpler approach to {x}?",
            "How would you structure {x} in a small codebase?",
            "What's the gotcha with {x}?",
        ],
        "replies": [
            "For {x}, reach for the boring, well-supported pattern first and add cleanup so you don't leak resources.",
            "Reproduce {x} in isolation, then bisect — most of the time the bug isn't where it looks.",
            "The tradeoff with {x} is usually read speed versus write cost; pick based on your access pattern.",
            "Keep {x} explicit and small; clever abstractions make this exact thing harder to debug later.",
        ],
    },
    "Home & DIY": {
        "weight": 0.7,
        "nouns": [
            "patching drywall", "loose cabinet hinges", "a raised garden bed",
            "a sticking door", "refinishing a scratched table", "a leaky faucet",
            "painting a high-traffic hallway", "mounting a TV on drywall",
            "a squeaky stair tread", "weatherstripping a drafty window",
            "building a simple bookshelf", "regrouting a shower", "a running toilet",
            "sealing a concrete garage floor", "hanging heavy shelves", "fixing a fence post",
        ],
        "frames": [
            "How do I tackle {x}?",
            "What's the right fix for {x}?",
            "What tools and materials do I need for {x}?",
            "Walk me through {x} step by step.",
            "What mistakes should I avoid with {x}?",
            "Can I DIY {x} or should I call someone?",
            "How long should {x} realistically take?",
            "What's the cheap, durable way to do {x}?",
        ],
        "replies": [
            "For {x}, prep is most of the job — surface, support, and the right fasteners.",
            "Do {x} in thin layers and let each stage cure before the next or it'll show.",
            "{x} is well within DIY range; just dry-fit everything before you commit.",
            "Re-seat into fresh, solid material when you do {x} so the repair actually holds.",
        ],
    },
    "Shopping & Marketplace": {
        "weight": 0.6,
        "nouns": [
            "a used sofa listing", "pricing a road bike to sell", "a Facebook Marketplace deal",
            "a used-car offer", "a laptop comparison", "a mattress purchase",
            "negotiating a furniture price", "a stroller resale value", "a camera kit bundle",
            "an espresso machine under $300", "a lawnmower listing", "haggling on a desk",
            "a phone trade-in", "a power-tool combo deal", "flipping a thrift find", "a winter-coat sale",
        ],
        "frames": [
            "How should I price {x}?",
            "Help me write {x}.",
            "Is {x} a good deal?",
            "How do I negotiate {x}?",
            "What should I check before {x}?",
            "Compare my options for {x}.",
            "What's a fair counteroffer on {x}?",
            "How do I make {x} sell faster?",
        ],
        "replies": [
            "Price {x} just below the nearest round number and lead the listing with the strongest photo.",
            "For {x}, anchor on recent comparable sales, not the original retail price.",
            "Before {x}, inspect the wear points and ask why they're selling — it sets your leverage.",
            "Bundle or sweeten {x} slightly rather than dropping the headline price; it moves faster.",
        ],
    },
    "Travel & Outdoors": {
        "weight": 0.8,
        "nouns": [
            "five days in Lisbon", "a Utah national-parks road trip", "booking cheap flights",
            "a week hiking the Alps", "getting around Tokyo", "a long weekend in Mexico City",
            "a coastal camping trip", "a first backpacking loop", "a layover in Reykjavik",
            "a family beach week", "a fall foliage drive", "a desert sunrise hike",
            "a budget Europe itinerary", "a national-park permit", "a sailing day trip", "a winter cabin getaway",
        ],
        "frames": [
            "Plan {x}.",
            "What's the best way to do {x}?",
            "How far ahead should I book {x}?",
            "Give me a packing list for {x}.",
            "Is {x} worth it, or is there a better option?",
            "What would you not miss on {x}?",
            "How do I do {x} on a budget?",
            "What's a realistic itinerary for {x}?",
        ],
        "replies": [
            "For {x}, anchor each day around one priority and leave slack — over-packed itineraries fall apart.",
            "Book {x} a few weeks out, set a fare alert, and stay flexible by a day or two.",
            "Pack {x} in layers with one packable shell; conditions flip faster than forecasts suggest.",
            "On {x}, start early to beat crowds and heat, and keep an easy bailout option.",
        ],
    },
    "Misc & Curiosity": {
        "weight": 1.1,
        "nouns": [
            "why the sky is blue", "how noise-canceling headphones work",
            "why leap years exist", "how vaccines train the immune system",
            "why onions make you cry", "how GPS knows your location",
            "what causes déjà vu", "how a microwave heats food",
            "why cats purr", "how bridges handle expansion", "what makes glass transparent",
            "how compound interest snowballs", "why the ocean is salty",
            "how planes stay in the air", "what fermentation actually is", "how memory foam works",
        ],
        "frames": [
            "Explain {x} simply.",
            "I've always wondered: {x}?",
            "What's the real answer to {x}?",
            "Break down {x} like I'm twelve.",
            "Is the common explanation of {x} actually right?",
            "How does {x} compare to {y}?",
            "What's a surprising fact about {x}?",
            "Walk me through {x} from first principles.",
        ],
        "replies": [
            "The short version of {x}: it's a simple mechanism that feels mysterious until you see the one key step.",
            "Most people get {x} half-right — the intuitive story misses what's actually doing the work.",
            "Think of {x} as a chain of small, ordinary effects that add up to something striking.",
            "Start {x} from the underlying physics and the 'weird' part stops being weird.",
        ],
    },
}

# Which topics bleed into each other in real usage (shared vocabulary). A
# fraction of conversations blend a primary topic with one of its neighbors so
# their text spans both — that's what pulls the theme-islands into a single
# connected continent with visible cross-links, instead of isolated balls.
ADJACENCY: dict[str, list[str]] = {
    "Design & Branding": ["Software & Tech", "Art & Illustration"],
    "Art & Illustration": ["Design & Branding", "Music & Audio", "Writing & Stories"],
    "Music & Audio": ["Art & Illustration", "Writing & Stories"],
    "Writing & Stories": ["Misc & Curiosity", "Faith & Spirituality", "Career & Work", "Art & Illustration"],
    "Faith & Spirituality": ["Writing & Stories", "Misc & Curiosity"],
    "Health & Wellness": ["Food & Cooking", "Misc & Curiosity", "Travel & Outdoors"],
    "Food & Cooking": ["Health & Wellness", "Home & DIY"],
    "Finance & Legal": ["Career & Work", "Shopping & Marketplace"],
    "Career & Work": ["Finance & Legal", "Software & Tech", "Writing & Stories"],
    "Software & Tech": ["Design & Branding", "Career & Work", "Misc & Curiosity"],
    "Home & DIY": ["Shopping & Marketplace", "Food & Cooking"],
    "Shopping & Marketplace": ["Home & DIY", "Finance & Legal"],
    "Travel & Outdoors": ["Misc & Curiosity", "Health & Wellness"],
    "Misc & Curiosity": ["Software & Tech", "Writing & Stories", "Health & Wellness",
                         "Travel & Outdoors", "Finance & Legal"],
}

# Share of conversations that mix in a related second topic.
P_BLEND = 0.35

# Message-count long tail: (cumulative probability, min, max) exchanges.
# One exchange = a user + an assistant turn, so msg_count ≈ 2 × exchanges.
_EXCHANGE_TIERS = [
    (0.70, 1, 3),    # most chats are short
    (0.90, 4, 8),
    (0.98, 9, 20),
    (1.00, 21, 45),  # rare marathons
]


def _n_exchanges(rng: random.Random) -> int:
    r = rng.random()
    for cutoff, lo, hi in _EXCHANGE_TIERS:
        if r < cutoff:
            return rng.randint(lo, hi)
    return rng.randint(21, 45)


def _two_distinct(rng: random.Random, items: list[str]) -> tuple[str, str]:
    a = rng.choice(items)
    b = rng.choice(items)
    while b == a and len(items) > 1:
        b = rng.choice(items)
    return a, b


def _exchange(rng: random.Random, key: str) -> list[tuple[str, str]]:
    """One user/assistant exchange drawn from topic `key`'s vocab."""
    t = TOPICS[key]
    x, y = _two_distinct(rng, t["nouns"])
    return [
        ("user", rng.choice(t["frames"]).format(x=x, y=y)),
        ("assistant", rng.choice(t["replies"]).format(x=x, y=y)),
    ]


def _make_turns(rng: random.Random, primary: str) -> list[tuple[str, str]]:
    """Transcript for one conversation. With probability P_BLEND it mixes in a
    related secondary topic so the conversation sits *between* themes — this is
    what links the map into a connected continent instead of isolated balls."""
    n_ex = _n_exchanges(rng)
    secondary = None
    if rng.random() < P_BLEND and ADJACENCY.get(primary):
        secondary = rng.choice(ADJACENCY[primary])
        n_ex = max(n_ex, 2)  # need room for both topics to appear

    # exchange #0 is always primary (so the title reads primary-flavored),
    # remaining exchanges lean primary but pull in the secondary ~45% of the time
    sources = [primary]
    for _ in range(n_ex - 1):
        sources.append(secondary if (secondary and rng.random() < 0.45) else primary)
    if secondary and secondary not in sources:  # guarantee the blend shows up
        sources[rng.randrange(1, len(sources))] = secondary

    turns: list[tuple[str, str]] = []
    for key in sources:
        turns.extend(_exchange(rng, key))
    return turns


def _title(turns: list[tuple[str, str]]) -> str:
    opener = turns[0][1]
    return opener.rstrip("?.").split(" — ")[0][:64]


def _allocate(rng: random.Random, n: int) -> list[str]:
    """Assign each of n conversations a topic, proportional to topic weight."""
    keys = list(TOPICS)
    weights = [TOPICS[k]["weight"] for k in keys]
    total = sum(weights)
    counts = {k: int(n * w / total) for k, w in zip(keys, weights)}
    # distribute rounding remainder onto the heaviest topics
    while sum(counts.values()) < n:
        k = max(keys, key=lambda k: TOPICS[k]["weight"] / (counts[k] + 1))
        counts[k] += 1
    assignments = [k for k, c in counts.items() for _ in range(c)]
    rng.shuffle(assignments)
    return assignments


def build_claude(rng: random.Random, items: list[tuple[str, list[tuple[str, str]]]]) -> list[dict]:
    base = datetime(2024, 6, 1, tzinfo=timezone.utc)
    out = []
    for i, (title, turns) in enumerate(items):
        created = base + timedelta(hours=rng.randint(0, 24 * 500))
        out.append(
            {
                "uuid": str(uuid.UUID(int=rng.getrandbits(128))),
                "name": title,
                "created_at": created.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "chat_messages": [
                    {"sender": "human" if role == "user" else "assistant", "text": text}
                    for role, text in turns
                ],
            }
        )
    return out


def build_chatgpt(rng: random.Random, items: list[tuple[str, list[tuple[str, str]]]]) -> list[dict]:
    base = datetime(2024, 6, 1, tzinfo=timezone.utc)
    out = []
    for i, (title, turns) in enumerate(items):
        created = base + timedelta(hours=rng.randint(0, 24 * 500))
        mapping: dict[str, dict] = {}
        parent = None
        last_id = None
        for role, text in turns:
            node_id = str(uuid.UUID(int=rng.getrandbits(128)))
            mapping[node_id] = {
                "id": node_id,
                "parent": parent,
                "children": [],
                "message": {
                    "author": {"role": role},
                    "content": {"content_type": "text", "parts": [text]},
                },
            }
            if parent is not None:
                mapping[parent]["children"].append(node_id)
            parent = node_id
            last_id = node_id
        out.append(
            {
                "id": str(uuid.UUID(int=rng.getrandbits(128))),
                "title": title,
                "create_time": created.timestamp(),
                "current_node": last_id,
                "mapping": mapping,
            }
        )
    return out


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join("..", "sample")
    n = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_N
    os.makedirs(out_dir, exist_ok=True)
    rng = random.Random(42)  # deterministic output

    conversations: list[tuple[str, list[tuple[str, str]]]] = []
    for primary in _allocate(rng, n):
        turns = _make_turns(rng, primary)
        conversations.append((_title(turns), turns))
    rng.shuffle(conversations)

    half = len(conversations) // 2
    claude = build_claude(rng, conversations[:half])
    chatgpt = build_chatgpt(rng, conversations[half:])

    claude_path = os.path.join(out_dir, "conversations-claude.json")
    chatgpt_path = os.path.join(out_dir, "conversations-chatgpt.json")
    with open(claude_path, "w") as f:
        json.dump(claude, f, indent=2)
    with open(chatgpt_path, "w") as f:
        json.dump(chatgpt, f, indent=2)

    print(f"Wrote {len(claude)} Claude conversations  -> {claude_path}")
    print(f"Wrote {len(chatgpt)} ChatGPT conversations -> {chatgpt_path}")
    print(f"\nBuild the map from it:\n    make map INPUT={out_dir}")


if __name__ == "__main__":
    main()
