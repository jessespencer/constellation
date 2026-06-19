"""Generate a small synthetic Claude + ChatGPT export so the pipeline runs
out of the box — no personal data required.

Writes two files into a sample directory (default ``../sample``):

    conversations-claude.json    # Claude export shape  (flat ``chat_messages``)
    conversations-chatgpt.json   # ChatGPT export shape (``mapping`` node-tree)

Both match the real export schemas closely enough that ``normalize.py`` parses
them identically to a genuine export. The text is invented but themed across
the curated categories in ``taxonomy.py`` so the resulting map shows distinct,
colorful clusters.

    python sample_data.py            # -> ../sample
    python sample_data.py /tmp/demo  # -> /tmp/demo

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

# Each topic: a pool of user openers and assistant snippets. We mix and match to
# create natural variation so embeddings spread the conversations realistically.
TOPICS: dict[str, dict[str, list[str]]] = {
    "design": {
        "user": [
            "How should I structure the visual hierarchy for a SaaS dashboard landing page?",
            "What font pairing works for a modern fintech brand?",
            "Critique my color palette: deep navy, warm coral, off-white. Too safe?",
            "I'm designing a logo for a coffee roaster. How do I make it feel hand-crafted?",
            "Walk me through building a design system token scale for spacing and type.",
        ],
        "assistant": [
            "Start with a clear focal point, then use size, weight, and whitespace to step the eye down through secondary and tertiary actions.",
            "Pair a geometric sans for headings with a humanist sans for body to balance trust and warmth; keep to two weights each.",
            "The palette is grounded but coral as the only accent risks monotony — add a desaturated tint for surfaces and reserve coral strictly for CTAs.",
            "Lean into an imperfect, slightly rough mark and a warm earthy palette; a custom ligature in the wordmark reads as artisanal.",
        ],
    },
    "music": {
        "user": [
            "Help me write a chorus for an indie folk song about leaving a hometown.",
            "What's a good chord progression for a melancholy lo-fi beat in A minor?",
            "How do I mix vocals so they sit on top without sounding harsh?",
            "Give me a Suno prompt for a dreamy synthwave track with a driving bassline.",
            "I recorded guitar in Logic Pro but it sounds thin. How do I fatten it up?",
        ],
        "assistant": [
            "Keep the chorus melodically higher than the verse and repeat one image — the road, the porch light — so it lands emotionally.",
            "Try Am - F - C - G with a borrowed Dm7 for color; sit the tempo around 70 bpm and swing the hats slightly.",
            "Carve 300 Hz mud, add a gentle de-esser at 6-8 kHz, and use parallel compression to keep the vocal present but smooth.",
            "Double-track the part, pan the takes hard left/right, and add a subtle short room reverb to glue them into one wide sound.",
        ],
    },
    "faith": {
        "user": [
            "What does the parable of the prodigal son teach about grace?",
            "Can you explain the historical context of Psalm 23?",
            "How do early church writers interpret the resurrection accounts?",
            "I'm preparing a sermon on forgiveness — what scriptures should anchor it?",
            "What's the difference between justification and sanctification in Christian theology?",
        ],
        "assistant": [
            "The father's running embrace before any apology pictures grace as unearned — restoration precedes the son's rehearsed confession.",
            "Written as a shepherd's psalm, it casts God as both guide and host; the rod and staff are tools of protection, not punishment.",
            "The earliest accounts emphasize the empty tomb and eyewitness testimony, with the church fathers reading them as bodily, not merely spiritual.",
            "Anchor it in Matthew 18, Colossians 3:13, and the Lord's Prayer — forgiveness flows from having first been forgiven.",
        ],
    },
    "health": {
        "user": [
            "What are evidence-based ways to improve deep sleep?",
            "I've been getting tension headaches at my desk. What might help?",
            "Which vitamins actually matter if I eat a balanced diet?",
            "How much protein do I really need to maintain muscle while cutting?",
            "What's a sensible beginner strength routine I can do three times a week?",
        ],
        "assistant": [
            "Keep a consistent wake time, get morning light, avoid caffeine after noon, and cool the room — these move deep sleep more than supplements.",
            "Check monitor height and chair support, take a micro-break every 30 minutes, and stretch the upper traps and neck flexors.",
            "For most balanced eaters, vitamin D and omega-3 are the common gaps; everything else is usually covered by food.",
            "Around 1.6-2.2 g/kg of body weight preserves lean mass in a deficit; spread it across three or four meals.",
        ],
    },
    "cooking": {
        "user": [
            "My sourdough comes out dense. What am I doing wrong?",
            "How do I get a restaurant-quality sear on a ribeye at home?",
            "Give me a weeknight dinner using chickpeas, spinach, and whatever's in the pantry.",
            "What's the trick to a silky, not-scrambled, carbonara?",
            "How do I brew a less bitter cup of coffee with a French press?",
        ],
        "assistant": [
            "Dense crumb usually means under-proofing or weak gluten — extend the bulk ferment and do a few sets of stretch-and-folds.",
            "Dry the steak, salt ahead, use a screaming-hot cast iron, and don't move it until a crust forms; finish with butter and thyme.",
            "Sauté garlic, add chickpeas and spinach with cumin and lemon, simmer with a splash of stock, and serve over rice or toast.",
            "Temper the egg-and-cheese mixture off the heat with hot pasta water so it emulsifies into a sauce instead of curdling.",
        ],
    },
    "finance": {
        "user": [
            "Should I prioritize my Roth IRA or paying down a 6% car loan?",
            "Explain how index fund expense ratios eat into long-term returns.",
            "Is dollar-cost averaging actually better than lump-sum investing?",
            "How do I think about an emergency fund versus investing extra cash?",
            "What are the tax implications of selling stock I've held for eight months?",
        ],
        "assistant": [
            "Capture any employer match first, then it's close — a guaranteed 6% by paying the loan often beats uncertain market returns.",
            "A 1% fee can quietly cost tens of thousands over decades; favor broad-market funds with expense ratios under 0.1%.",
            "Lump-sum wins on average since markets trend up, but DCA reduces regret risk and smooths the entry if you're anxious.",
            "Hold three to six months of expenses liquid first; beyond that, extra cash generally compounds better invested.",
        ],
    },
    "software": {
        "user": [
            "What's the cleanest way to debounce a search input in React?",
            "How do I structure a Python project so imports don't get messy?",
            "My git history is a tangle — how do I squash and rebase safely?",
            "When should I reach for a database index, and what are the costs?",
            "How do I containerize a small Flask app for local development?",
        ],
        "assistant": [
            "Wrap the handler in a debounce that fires after the user pauses, and clean up the timer in a useEffect return to avoid leaks.",
            "Use a src/ layout with a single top-level package and absolute imports; install in editable mode so paths resolve consistently.",
            "Branch first, then interactive-rebase onto main, squashing fixups; never rewrite history that others have already pulled.",
            "Index columns you filter or join on frequently; the cost is slower writes and extra storage, so don't index everything.",
        ],
    },
    "travel": {
        "user": [
            "Plan a five-day itinerary for first-timers in Lisbon.",
            "What's the best way to see the national parks in Utah on a road trip?",
            "How far ahead should I book flights to get a good price?",
            "Give me a packing list for a week of summer hiking in the Alps.",
            "Is it worth renting a car in Tokyo or should I rely on trains?",
        ],
        "assistant": [
            "Split it between Alfama and Belem, day-trip to Sintra, and leave an evening for a fado dinner and the miradouros at sunset.",
            "Loop the Mighty Five counter-clockwise from Zion; base in Moab for Arches and Canyonlands and start hikes at dawn to beat heat.",
            "For most routes the sweet spot is one to three months out; set a fare alert and be flexible by a day or two.",
            "Layers, a packable rain shell, broken-in boots, sun protection, and a 25-liter pack — the weather flips fast at altitude.",
        ],
    },
    "writing": {
        "user": [
            "Help me open a short story about a lighthouse keeper who stops seeing ships.",
            "How do I make my dialogue sound less stiff?",
            "Give me feedback on the pacing of a children's bedtime story.",
            "What's a strong structure for a personal essay about moving cities?",
            "Rewrite this sentence to be more vivid: 'The room was old and quiet.'",
        ],
        "assistant": [
            "Open in the middle of his routine, then break it — the morning the horizon stays empty — so absence becomes the inciting image.",
            "Cut the throat-clearing, let characters interrupt and talk past each other, and trust subtext to carry what they won't say.",
            "Bedtime pacing should decelerate: shorter sentences, softer sounds, and a final image that resolves rather than excites.",
            "Try a then-and-now spine: anchor a concrete scene on arrival, braid in memory, and close on what the new place revealed.",
        ],
    },
    "diy": {
        "user": [
            "How do I patch and repaint a section of drywall after removing a shelf?",
            "My kitchen cabinet hinges are loose. What's the fix?",
            "What's the right way to build a simple raised garden bed?",
            "How do I stop a door from sticking in humid weather?",
            "Best approach to refinish a scratched wooden dining table?",
        ],
        "assistant": [
            "Cut a clean square, back it with a patch, mud in thin coats sanding between, then prime before matching the wall color.",
            "Re-seat the screws into fresh wood — fill the stripped holes with glued toothpicks or dowels, then drive new screws.",
            "Use untreated cedar, join corners with deck screws, line with landscape fabric, and fill with a soil-compost mix.",
            "Sand the binding edge lightly, seal the raw wood so it doesn't absorb moisture, and check the hinges aren't sagging.",
        ],
    },
}

# About how many conversations to generate per topic. With ~10 topics this is
# enough for UMAP (n_neighbors=15) and HDBSCAN to find structure.
PER_TOPIC = 7


def _make_turns(rng: random.Random, topic: dict[str, list[str]]) -> list[tuple[str, str]]:
    """Build an alternating user/assistant transcript for one conversation."""
    n_exchanges = rng.randint(1, 3)
    turns: list[tuple[str, str]] = []
    for _ in range(n_exchanges):
        turns.append(("user", rng.choice(topic["user"])))
        turns.append(("assistant", rng.choice(topic["assistant"])))
    return turns


def _title(rng: random.Random, topic: dict[str, list[str]]) -> str:
    opener = rng.choice(topic["user"])
    return opener.rstrip("?.").split(" — ")[0][:60]


def build_claude(rng: random.Random, items: list[tuple[str, list[tuple[str, str]]]]) -> list[dict]:
    base = datetime(2025, 1, 1, tzinfo=timezone.utc)
    out = []
    for i, (title, turns) in enumerate(items):
        created = base + timedelta(days=i, hours=rng.randint(0, 23))
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
    base = datetime(2025, 6, 1, tzinfo=timezone.utc)
    out = []
    for i, (title, turns) in enumerate(items):
        created = base + timedelta(days=i, hours=rng.randint(0, 23))
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
    os.makedirs(out_dir, exist_ok=True)
    rng = random.Random(42)  # deterministic output

    # Generate per-topic conversations, then split across the two export formats.
    conversations: list[tuple[str, list[tuple[str, str]]]] = []
    for topic in TOPICS.values():
        for _ in range(PER_TOPIC):
            conversations.append((_title(rng, topic), _make_turns(rng, topic)))
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
