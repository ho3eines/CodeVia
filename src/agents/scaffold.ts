import type { AgentType, Project, Task } from "../domain/entities.js";

/**
 * Deterministic code scaffolds — what backend/frontend/database implementers
 * commit when no real AI provider is configured.
 *
 * Instead of a markdown change-note, each implementer writes a small but
 * VALID source file in the project's own stack (detected from the project
 * definition selections) at the conventional path for that stack, with the
 * task wired in as TODOs. The change-note is kept as a second file so the
 * request + research brief stay traceable next to the code.
 *
 * Real-AI mode (`fileContent` with a chat session) is untouched: the model
 * still writes full implementations to model-chosen paths.
 */

export interface Scaffold {
  path: string;
  content: string;
}

export interface Entity {
  /** "Login" — class/component/table stem. */
  pascal: string;
  /** "login" — routes, file names, css classes. */
  route: string;
  /** "Login" — human title. */
  title: string;
}

export type BackendKind = "csharp" | "node-ts" | "node-js" | "python" | "java" | "php" | "go";
export type FrontendKind = "react" | "vue" | "angular" | "svelte" | "flutter" | "html";

export interface Stack {
  backend: BackendKind;
  frontend: FrontendKind;
  /** PascalCase project stem for namespaces/packages. */
  project: string;
  /** Lowercase alnum project stem for java packages etc. */
  pkg: string;
}

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";

const pascalize = (s: string): string =>
  s
    .split(/[^a-zA-Z0-9\u0600-\u06FF]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("")
    .slice(0, 32) || "Feature";

export function detectStack(project: Project): Stack {
  const caps = (project.capabilities ?? {}) as unknown as Record<string, string[] | undefined>;
  const langs = (caps.languages ?? []).map((l) => l.toLowerCase());
  const fws = (caps.frameworks ?? []).map((f) => f.toLowerCase());
  const has = (list: string[], ...keys: string[]): boolean => keys.some((k) => list.some((v) => v.includes(k)));

  let backend: BackendKind = "node-ts";
  if (has(langs, "c#", "csharp") || has(fws, "dotnet", "aspnet")) backend = "csharp";
  else if (has(langs, "python") || has(fws, "django", "fastapi", "flask")) backend = "python";
  else if (langs.some((l) => l === "java" || l === "kotlin") || has(fws, "spring")) backend = "java";
  else if (has(langs, "go") || has(fws, "gin", "echo", "fiber")) backend = "go";
  else if (has(langs, "php") || has(fws, "laravel", "symfony")) backend = "php";
  else if (has(langs, "javascript") && !has(langs, "typescript")) backend = "node-js";
  else if (has(fws, "express", "nest", "fastify", "node")) backend = has(langs, "javascript") ? "node-js" : "node-ts";

  let frontend: FrontendKind = "react";
  if (has(fws, "vue", "nuxt")) frontend = "vue";
  else if (has(fws, "angular")) frontend = "angular";
  else if (has(fws, "svelte")) frontend = "svelte";
  else if (has(fws, "flutter") || has(langs, "dart")) frontend = "flutter";
  else if (has(fws, "html", "jquery", "htmx") && !has(fws, "react", "next")) frontend = "html";

  const projectName = pascalize(project.name || "App").replace(/[^a-zA-Z0-9]/g, "") || "App";
  const pkg = projectName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "app";
  return { backend, frontend, project: projectName, pkg };
}

const ENTITY_RULES: Array<[RegExp, string]> = [
  [/sign[\s_-]?up|register|signup/i, "Register"],
  [/login|sign[\s_-]?in|auth(entication|orization)?/i, "Login"],
  [/password|reset/i, "Password"],
  [/checkout/i, "Checkout"],
  [/subscription/i, "Subscription"],
  [/payment|billing|invoice/i, "Payment"],
  [/order/i, "Order"],
  [/cart|basket/i, "Cart"],
  [/product|catalog/i, "Product"],
  [/categor/i, "Category"],
  [/role|permission/i, "Role"],
  [/user|profile|account|member/i, "User"],
  [/session|token/i, "Session"],
  [/search/i, "Search"],
  [/notif|alert|reminder/i, "Notification"],
  [/message|chat|conversation/i, "Message"],
  [/comment|review|rating/i, "Comment"],
  [/upload|download|attach|media|image|avatar|gallery|file/i, "File"],
  [/dashboard|report|analytic|statistic/i, "Dashboard"],
  [/setting|config|preference/i, "Settings"],
  [/task|todo/i, "Task"],
  [/project/i, "Project"],
  [/team|organization/i, "Team"],
  [/email|newsletter/i, "Newsletter"],
  [/contact/i, "Contact"],
  [/support|ticket/i, "Ticket"],
];

const STOPWORDS = new Set(
  "add new create update delete fix implement build make page api app the and for with from into your our this that page screen button form data list view get set all".split(" "),
);

export function entityFor(title: string, description = ""): Entity {
  const text = `${title} ${description}`;
  for (const [re, name] of ENTITY_RULES) {
    if (re.test(text)) return toEntity(name);
  }
  const word = text
    .split(/[^a-zA-Z0-9\u0600-\u06FF]+/)
    .map((w) => w.trim())
    .find((w) => w.length > 3 && !STOPWORDS.has(w.toLowerCase()));
  const name = word ? pascalize(word) : "Feature";
  // Identifiers must stay ASCII (class names, file paths) — Persian or
  // symbol-only matches fall back to a generic feature stem.
  if (!/[a-zA-Z]/.test(name)) return toEntity("Feature");
  return toEntity(name.replace(/[^a-zA-Z0-9]/g, "") || "Feature");
}

function toEntity(pascal: string): Entity {
  const title = pascal.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return { pascal, route: pascal.toLowerCase(), title };
}

/** Traceability note committed next to the scaffold (second file). */
export function notePathFor(parentTaskId: string, short: string, slug: string): string {
  return `docs/tasks/${parentTaskId}-${short}-${slug}.md`;
}

export function changeNote(agentName: string, child: Task, description: string, brief: string, fixContext?: string): string {
  return [
    `# ${child.title}`,
    ``,
    `> Implemented by ${agentName} — change note next to the scaffolded code.`,
    ``,
    `## Request`,
    description || "(no description)",
    ``,
    `## Research brief`,
    brief.split("\n").slice(0, 24).join("\n"),
    ...(fixContext ? [``, `## QA feedback addressed`, fixContext.split("\n").slice(0, 12).join("\n")] : []),
    ``,
    `_Subtask ${child.id} · ${new Date().toISOString()}_`,
    ``,
  ].join("\n");
}

export interface ScaffoldInput {
  agentType: AgentType;
  project: Project;
  task: Task;
  childId: string;
  brief: string;
  fixContext?: string;
}

/**
 * Source-file scaffold for an implementer subtask. Returns undefined for
 * agent types without a scaffold (caller falls back to the change note).
 */
export function scaffoldFor(input: ScaffoldInput): Scaffold | undefined {
  const { agentType, project, task, childId, brief, fixContext } = input;
  const stack = detectStack(project);
  const entity = entityFor(task.title, task.description);
  const ctx = { stack, entity, taskTitle: task.title, childId, agentName: agentLabel(agentType), brief, fixContext };

  switch (agentType) {
    case "backend-developer":
      return backendScaffold(stack.backend, ctx);
    case "frontend-developer":
    case "uiux":
      return frontendScaffold(stack.frontend, ctx);
    case "database":
      return databaseScaffold(ctx);
    default:
      return undefined;
  }
}

function agentLabel(type: AgentType): string {
  if (type === "backend-developer") return "Backend Developer";
  if (type === "frontend-developer") return "Frontend Developer";
  if (type === "database") return "Database Developer";
  return "Developer";
}

interface Ctx {
  stack: Stack;
  entity: Entity;
  taskTitle: string;
  childId: string;
  agentName: string;
  brief: string;
  fixContext?: string;
}

function briefLines(prefix: string, brief: string, max = 5): string {
  return brief
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((l) => `${prefix} ${l.slice(0, 120)}`)
    .join("\n");
}

function header(prefix: string, what: string, ctx: Ctx): string {
  return [
    `${prefix} ${what}`,
    `${prefix} Task: ${ctx.taskTitle} (subtask ${ctx.childId})`,
    `${prefix} Scaffolded by ${ctx.agentName} (deterministic mode — connect a real AI provider for full logic).`,
    briefLines(prefix, ctx.brief),
    ...(ctx.fixContext ? [`${prefix} QA feedback addressed:`, briefLines(prefix, ctx.fixContext, 4)] : []),
  ].join("\n");
}

const shortTitle = (t: string): string => t.replace(/["\n]/g, "").slice(0, 80);

// ---- backend ---------------------------------------------------------------

function backendScaffold(kind: BackendKind, ctx: Ctx): Scaffold {
  const e = ctx.entity;
  switch (kind) {
    case "csharp": {
      const path = `src/${ctx.stack.project}.Api/Controllers/${e.pascal}Controller.cs`;
      const content = `${header("//", `${ctx.stack.project} — ${e.title} API`, ctx)}
using Microsoft.AspNetCore.Mvc;

namespace ${ctx.stack.project}.Api.Controllers;

[ApiController]
[Route("api/${e.route}")]
public class ${e.pascal}Controller : ControllerBase
{
    // GET api/${e.route} — TODO: ${shortTitle(ctx.taskTitle)}
    [HttpGet]
    public IActionResult List()
    {
        // TODO: fetch via ${e.pascal}Service.
        return Ok(new { data = Array.Empty<object>(), todo = "${shortTitle(ctx.taskTitle)}" });
    }

    // GET api/${e.route}/{id} — TODO
    [HttpGet("{id:int}")]
    public IActionResult Get(int id)
    {
        // TODO: fetch one via ${e.pascal}Service.
        return Ok(new { id });
    }

    // POST api/${e.route} — TODO
    [HttpPost]
    public IActionResult Create([FromBody] ${e.pascal}Request request)
    {
        // TODO: validate + persist via ${e.pascal}Service.
        return Created($"/api/${e.route}/1", new { id = 1, name = request.Name });
    }
}

public record ${e.pascal}Request(string Name);
`;
      return { path, content };
    }
    case "python": {
      const snake = e.route.replace(/-/g, "_");
      const path = `app/routers/${e.route}.py`;
      const content = `${header("#", `${e.title} API router`, ctx)}
from fastapi import APIRouter, status

router = APIRouter(prefix="/api/${e.route}", tags=["${e.route}"])


# GET /api/${e.route} — TODO: ${shortTitle(ctx.taskTitle)}
@router.get("/")
async def list_${snake}():
    """TODO: fetch via ${e.pascal}Service."""
    return {"data": [], "todo": "${shortTitle(ctx.taskTitle)}"}


# GET /api/${e.route}/{item_id} — TODO
@router.get("/{item_id}")
async def get_${snake}(item_id: int):
    """TODO: fetch one via ${e.pascal}Service."""
    return {"id": item_id}


# POST /api/${e.route} — TODO
@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_${snake}(payload: dict):
    """TODO: validate + persist; body arrives as payload."""
    return {"id": 1}
`;
      return { path, content };
    }
    case "java": {
      const path = `src/main/java/com/${ctx.stack.pkg}/${e.pascal}Controller.java`;
      const content = `${header("//", `${e.title} API controller`, ctx)}
package com.${ctx.stack.pkg};

import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/${e.route}")
public class ${e.pascal}Controller {

    // GET /api/${e.route} — TODO: ${shortTitle(ctx.taskTitle)}
    @GetMapping
    public Map<String, Object> list() {
        // TODO: fetch via ${e.pascal}Service.
        return Map.of("data", List.of(), "todo", "${shortTitle(ctx.taskTitle)}");
    }

    // GET /api/${e.route}/{id} — TODO
    @GetMapping("/{id}")
    public Map<String, Object> get(@PathVariable long id) {
        // TODO: fetch one via ${e.pascal}Service.
        return Map.of("id", id);
    }

    // POST /api/${e.route} — TODO
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> create(@RequestBody Map<String, Object> body) {
        // TODO: validate + persist; body arrives as a map.
        return Map.of("id", 1L);
    }
}
`;
      return { path, content };
    }
    case "php": {
      const path = `app/Http/Controllers/${e.pascal}Controller.php`;
      const content = `<?php
${header("//", `${e.title} API controller`, ctx)}
namespace App\\Http\\Controllers;

use Illuminate\\Http\\JsonResponse;
use Illuminate\\Http\\Request;

class ${e.pascal}Controller extends Controller
{
    // GET /api/${e.route} — TODO: ${shortTitle(ctx.taskTitle)}
    public function index(): JsonResponse
    {
        // TODO: fetch via ${e.pascal}Service.
        return response()->json(["data" => [], "todo" => "${shortTitle(ctx.taskTitle)}"]);
    }

    // GET /api/${e.route}/{id} — TODO
    public function show(int $id): JsonResponse
    {
        // TODO: fetch one via ${e.pascal}Service.
        return response()->json(["id" => $id]);
    }

    // POST /api/${e.route} — TODO
    public function store(Request $request): JsonResponse
    {
        // TODO: validate + persist; input via $request->all().
        return response()->json(["id" => 1], 201);
    }
}
`;
      return { path, content };
    }
    case "go": {
      const path = `internal/handlers/${e.route}.go`;
      const content = `${header("//", `${e.title} HTTP handlers`, ctx)}
package handlers

import (
	"encoding/json"
	"net/http"
)

// GET /api/${e.route} — TODO: ${shortTitle(ctx.taskTitle)}
func ${e.pascal}List(w http.ResponseWriter, r *http.Request) {
	// TODO: fetch via ${e.pascal}Service.
	writeJSON(w, http.StatusOK, map[string]any{"data": []any{}, "todo": "${shortTitle(ctx.taskTitle)}"})
}

// POST /api/${e.route} — TODO
func ${e.pascal}Create(w http.ResponseWriter, r *http.Request) {
	// TODO: validate + persist; decode r.Body.
	writeJSON(w, http.StatusCreated, map[string]any{"id": 1})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json");
	w.WriteHeader(status);
	_ = json.NewEncoder(w).Encode(v)
}
`;
      return { path, content };
    }
    case "node-js": {
      const path = `src/routes/${e.route}.routes.js`;
      const content = `${header("//", `${e.title} API routes`, ctx)}
import { Router } from "express";

export const ${e.route}Router = Router();

// GET /api/${e.route} — TODO: ${shortTitle(ctx.taskTitle)}
${e.route}Router.get("/", async (_req, res) => {
  // TODO: fetch via ${e.pascal}Service.
  res.json({ data: [], todo: "${shortTitle(ctx.taskTitle)}" });
});

// GET /api/${e.route}/:id — TODO
${e.route}Router.get("/:id", async (req, res) => {
  // TODO: fetch one via ${e.pascal}Service.
  res.json({ id: req.params.id });
});

// POST /api/${e.route} — TODO
${e.route}Router.post("/", async (req, res) => {
  // TODO: validate + persist; body on req.body.
  res.status(201).json({ id: 1 });
});
`;
      return { path, content };
    }
    case "node-ts":
    default: {
      const path = `src/routes/${e.route}.routes.ts`;
      const content = `${header("//", `${e.title} API routes`, ctx)}
import { Router, type Request, type Response } from "express";

export const ${e.route}Router = Router();

// GET /api/${e.route} — TODO: ${shortTitle(ctx.taskTitle)}
${e.route}Router.get("/", async (_req: Request, res: Response) => {
  // TODO: fetch via ${e.pascal}Service.
  res.json({ data: [], todo: "${shortTitle(ctx.taskTitle)}" });
});

// GET /api/${e.route}/:id — TODO
${e.route}Router.get("/:id", async (req: Request, res: Response) => {
  // TODO: fetch one via ${e.pascal}Service.
  res.json({ id: req.params.id });
});

// POST /api/${e.route} — TODO
${e.route}Router.post("/", async (req: Request, res: Response) => {
  // TODO: validate + persist; body on req.body.
  res.status(201).json({ id: 1 });
});
`;
      return { path, content };
    }
  }
}

// ---- frontend --------------------------------------------------------------

function frontendScaffold(kind: FrontendKind, ctx: Ctx): Scaffold {
  const e = ctx.entity;
  switch (kind) {
    case "vue": {
      const path = `src/views/${e.pascal}View.vue`;
      const content = `<!-- ${e.title} page — Task: ${ctx.taskTitle} (subtask ${ctx.childId}) -->
<!-- Scaffolded by ${ctx.agentName} (deterministic mode — connect a real AI provider for full logic). -->
<script setup lang="ts">
import { ref } from "vue";

const value = ref("");
const status = ref<string | null>(null);

async function onSubmit(): Promise<void> {
  // TODO: POST /api/${e.route} with { value: value.value }.
  status.value = "TODO: wire this form to POST /api/${e.route}";
}
</script>

<template>
  <main class="${e.route}-page">
    <h1>${e.title}</h1>
    <form @submit.prevent="onSubmit">
      <input v-model="value" placeholder="${e.title}…" />
      <button type="submit">Submit</button>
    </form>
    <p v-if="status" role="status">{{ status }}</p>
  </main>
</template>
`;
      return { path, content };
    }
    case "angular": {
      const path = `src/app/${e.route}/${e.route}.component.ts`;
      const template = [
        `<main class="${e.route}-page">`,
        `  <h1>${e.title}</h1>`,
        `  <!-- TODO: form posting to /api/${e.route} -->`,
        `</main>`,
      ].join("\n");
      const content = `${header("//", `${e.title} component`, ctx)}
import { Component } from "@angular/core";

@Component({
  selector: "app-${e.route}",
  template: \`
${template}
  \`,
})
export class ${e.pascal}Component {
  // TODO: POST /api/${e.route} — ${shortTitle(ctx.taskTitle)}
}
`;
      return { path, content };
    }
    case "svelte": {
      const path = `src/routes/${e.route}/+page.svelte`;
      const content = `<!-- ${e.title} page — Task: ${ctx.taskTitle} (subtask ${ctx.childId}) -->
<!-- Scaffolded by ${ctx.agentName} (deterministic mode — connect a real AI provider for full logic). -->
<script lang="ts">
  let value = "";
  let status: string | null = null;

  async function onSubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    // TODO: POST /api/${e.route} with { value }.
    status = "TODO: wire this form to POST /api/${e.route}";
  }
</script>

<main class="${e.route}-page">
  <h1>${e.title}</h1>
  <form on:submit={onSubmit}>
    <input bind:value placeholder="${e.title}…" />
    <button type="submit">Submit</button>
  </form>
  {#if status}<p role="status">{status}</p>{/if}
</main>
`;
      return { path, content };
    }
    case "flutter": {
      const path = `lib/pages/${e.route}_page.dart`;
      const content = `${header("//", `${e.title} page`, ctx)}
import 'package:flutter/material.dart';

class ${e.pascal}Page extends StatefulWidget {
  const ${e.pascal}Page({super.key});

  @override
  State<${e.pascal}Page> createState() => _${e.pascal}PageState();
}

class _${e.pascal}PageState extends State<${e.pascal}Page> {
  final _controller = TextEditingController();
  String? _status;

  Future<void> _submit() async {
    // TODO: POST /api/${e.route} with { value: _controller.text }.
    setState(() => _status = 'TODO: wire this form to POST /api/${e.route}');
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('${e.title}')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            TextField(controller: _controller, decoration: const InputDecoration(hintText: '${e.title}...')),
            const SizedBox(height: 12),
            ElevatedButton(onPressed: _submit, child: const Text('Submit')),
            if (_status != null) Text(_status!),
          ],
        ),
      ),
    );
  }
}
`;
      return { path, content };
    }
    case "html": {
      const path = `src/pages/${e.route}.html`;
      const content = `<!-- ${e.title} page — Task: ${ctx.taskTitle} (subtask ${ctx.childId}) -->
<!-- Scaffolded by ${ctx.agentName} (deterministic mode — connect a real AI provider for full logic). -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${e.title}</title>
  </head>
  <body>
    <main class="${e.route}-page">
      <h1>${e.title}</h1>
      <form id="${e.route}-form">
        <input name="value" placeholder="${e.title}..." />
        <button type="submit">Submit</button>
      </form>
      <p id="${e.route}-status" role="status"></p>
    </main>
    <script>
      // TODO: POST /api/${e.route} — ${shortTitle(ctx.taskTitle)}
      document.getElementById("${e.route}-form").addEventListener("submit", (e) => {
        e.preventDefault();
        document.getElementById("${e.route}-status").textContent = "TODO: wire this form to POST /api/${e.route}";
      });
    </script>
  </body>
</html>
`;
      return { path, content };
    }
    case "react":
    default: {
      const path = `src/pages/${e.pascal}Page.tsx`;
      const content = `${header("//", `${e.title} page`, ctx)}
import { useState, type FormEvent } from "react";

export default function ${e.pascal}Page() {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    // TODO: POST /api/${e.route} with { value }.
    setStatus("TODO: wire this form to POST /api/${e.route}");
  }

  return (
    <main className="${e.route}-page">
      <h1>${e.title}</h1>
      <form onSubmit={onSubmit}>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="${e.title}…" />
        <button type="submit">Submit</button>
      </form>
      {status ? <p role="status">{status}</p> : null}
    </main>
  );
}
`;
      return { path, content };
    }
  }
}

// ---- database --------------------------------------------------------------

function databaseScaffold(ctx: Ctx): Scaffold {
  const e = ctx.entity;
  const table = e.route.endsWith("s") ? e.route : `${e.route}s`;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const path = `db/migrations/${stamp}_${e.route}.sql`;
  const content = `${header("--", `${e.title} migration`, ctx)}
CREATE TABLE IF NOT EXISTS ${table} (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- TODO: columns for "${shortTitle(ctx.taskTitle)}"
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
  return { path, content };
}
