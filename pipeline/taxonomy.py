"""Curated high-level categories + zero-shot assignment.

HDBSCAN produced incoherent blobs (a "pregnancy" cluster full of leap-years and
spiders, a 389-node "design" catch-all). Instead we define a handful of broad,
human-meaningful categories and assign each conversation to its nearest one by
cosine similarity in the SAME embedding space (all-mpnet-base-v2). Fully local,
deterministic, and easy to tune — just edit the prototypes below.

Each prototype is a rich phrase of representative vocabulary (drawn from the
actual data) so the category vector is robust.
"""
from __future__ import annotations

import numpy as np

# name -> descriptive prototype (vocabulary that defines the category)
CATEGORIES: list[tuple[str, str]] = [
    ("Design & Branding",
     "user interface and UX design, product design, logo design, branding, "
     "typography, fonts, color palette, icons, layout, visual hierarchy, "
     "design system, wireframe, mockup"),
    ("Art & Illustration",
     "illustration, image generation, AI art, painting, drawing, album cover "
     "art, character design, scene composition, photo editing, picture book "
     "illustration, watercolor, portrait, poster art"),
    ("Music & Audio",
     "music production, songwriting, lyrics, chorus, Suno song prompt, melody, "
     "audio interface, Logic Pro, recording, mixing, plugins, guitar, vinyl "
     "records, album"),
    ("Writing & Stories",
     "creative writing, short story, children's story, narrative, characters, "
     "plot, fiction, screenplay, poem, copywriting, editing prose"),
    ("Faith & Spirituality",
     "Bible, scripture, God, Jesus, Christian theology, prayer, church, "
     "biblical verse, psalm, prophet, apologetics, faith, sermon"),
    ("Health & Wellness",
     "health, medical symptoms, pregnancy, nausea, supplements, vitamins, "
     "doctor, nutrition, exercise, fitness, sleep, mental health, medication"),
    ("Food & Cooking",
     "recipe, cooking, baking, food, ingredients, meal, kitchen, eggs, bread "
     "yeast, coffee, oil, flavor, dinner"),
    ("Finance & Legal",
     "personal finance, taxes, investing, stocks, cryptocurrency, XRP crypto, "
     "retirement account, Roth IRA, insurance, budget, expenses, legal advice, "
     "contract, mortgage, savings, valuation"),
    ("Career & Work",
     "work, business strategy, product management, OKRs, productivity, "
     "executive communication, professional email, meeting, project planning, "
     "AI workflow, team, leadership, hiring"),
    ("Software & Tech",
     "software, programming, code, GitHub, app development, computer setup, "
     "file management, troubleshooting devices, database, terminal, server, "
     "networking, hardware"),
    ("Home & DIY",
     "home improvement, repair, painting walls, fence, garage, plumbing, "
     "cabinets, renovation, tools, garden, furniture, cleaning, household"),
    ("Shopping & Marketplace",
     "buying and selling, marketplace listing, pricing an item, Facebook "
     "Marketplace, deal, car purchase, vehicle, shopping, product comparison, "
     "reseller, discount"),
    ("Travel & Outdoors",
     "travel planning, trip itinerary, flights, hotel booking, vacation, "
     "camping trip, hiking trail, national park visit, road trip, destinations, "
     "things to do in a city"),
    ("Misc & Curiosity",
     "general knowledge question, trivia, how does this work, explanation, "
     "random curiosity, definition, fun fact, miscellaneous"),
]


def _normalize(emb: np.ndarray) -> np.ndarray:
    emb = emb.astype(np.float32)
    norms = np.linalg.norm(emb, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return emb / norms


def assign_categories(node_embeddings: np.ndarray, model=None) -> tuple[np.ndarray, list[str]]:
    """Return (labels array of category indices, category names)."""
    names = [name for name, _ in CATEGORIES]
    prototypes = [f"{name}. {desc}" for name, desc in CATEGORIES]

    if model is None:
        from sentence_transformers import SentenceTransformer

        model = SentenceTransformer("all-mpnet-base-v2")
    proto_emb = _normalize(
        np.asarray(model.encode(prototypes, normalize_embeddings=True))
    )
    node_emb = _normalize(node_embeddings)
    sims = node_emb @ proto_emb.T  # (n_nodes, n_categories)
    labels = sims.argmax(axis=1).astype(int)
    return labels, names
