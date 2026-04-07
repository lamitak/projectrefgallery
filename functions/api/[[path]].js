// Lamitak Gallery - API Handler
// Pages Function: functions/api/[[path]].js
// Handles all /api/* routes with D1 database and R2 storage

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  const images = env.IMAGES;
  const method = request.method;
  const path = "/" + (params.path?.join("/") || "");

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  try {
    // ─── GET /api/data — Fetch everything ───
    if (path === "/data" && method === "GET") {
      const [cats, skus, projects, projectSkuTags, projectImages, settings] = await Promise.all([
        db.prepare("SELECT * FROM categories ORDER BY name").all(),
        db.prepare("SELECT * FROM skus ORDER BY code").all(),
        db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all(),
        db.prepare("SELECT * FROM project_sku_tags").all(),
        db.prepare("SELECT * FROM project_images ORDER BY created_at").all(),
        db.prepare("SELECT * FROM settings").all(),
      ]);

      // Assemble projects with their sku tags and images
      const assembledProjects = projects.results.map((p) => ({
        id: p.id,
        name: p.name,
        date: p.date,
        designer: p.designer,
        photographer: p.photographer,
        description: p.description,
        internalOnly: !!p.internal_only,
        featuredImageId: p.featured_image_id,
        country: p.country || "",
        skuIds: projectSkuTags.results.filter((t) => t.project_id === p.id).map((t) => t.sku_id),
        images: projectImages.results
          .filter((img) => img.project_id === p.id)
          .map((img) => ({ id: img.id, url: img.url, caption: img.caption })),
      }));

      const settingsObj = {};
      settings.results.forEach((s) => (settingsObj[s.key] = s.value));

      return json({
        categories: cats.results.map((c) => c.name),
        skus: skus.results.map((s) => ({ id: s.id, code: s.code, name: s.name, category: s.category })),
        projects: assembledProjects,
        settings: settingsObj,
      });
    }

    // ─── SKUS ───

    if (path === "/skus" && method === "POST") {
      const body = await request.json();
      const { code, name, category } = body;
      if (!code || !name) return err("code and name required");
      const result = await db.prepare("INSERT INTO skus (code, name, category) VALUES (?, ?, ?)").bind(code.toUpperCase(), name, category || "Uncategorized").run();
      return json({ id: result.meta.last_row_id, code: code.toUpperCase(), name, category: category || "Uncategorized" }, 201);
    }

    if (path.startsWith("/skus/") && method === "PUT") {
      const id = parseInt(path.split("/")[2]);
      const body = await request.json();
      const { code, name, category } = body;
      await db.prepare("UPDATE skus SET code = ?, name = ?, category = ? WHERE id = ?").bind(code.toUpperCase(), name, category, id).run();
      return json({ id, code: code.toUpperCase(), name, category });
    }

    if (path.startsWith("/skus/") && method === "DELETE") {
      const id = parseInt(path.split("/")[2]);
      await db.prepare("DELETE FROM project_sku_tags WHERE sku_id = ?").bind(id).run();
      await db.prepare("DELETE FROM skus WHERE id = ?").bind(id).run();
      return json({ deleted: id });
    }

    if (path === "/skus/bulk" && method === "POST") {
      const body = await request.json();
      const { skus: skuList, categories: newCats, updateExisting } = body;
      // Add new categories
      if (newCats && newCats.length > 0) {
        for (const cat of newCats) {
          await db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").bind(cat).run();
        }
      }
      // Add or update SKUs
      const added = [];
      const updated = [];
      for (const s of skuList) {
        const code = s.code.toUpperCase();
        try {
          const result = await db.prepare("INSERT INTO skus (code, name, category) VALUES (?, ?, ?)").bind(code, s.name, s.category || "Uncategorized").run();
          added.push({ id: result.meta.last_row_id, ...s });
        } catch (e) {
          // Duplicate code — update if requested
          if (updateExisting) {
            try {
              await db.prepare("UPDATE skus SET name = ?, category = ? WHERE code = ?").bind(s.name, s.category || "Uncategorized", code).run();
              updated.push({ code, ...s });
            } catch (e2) {}
          }
        }
      }
      return json({ added: added.length, updated: updated.length, skus: added }, 201);
    }

    // ─── PROJECTS ───

    if (path === "/projects" && method === "POST") {
      const body = await request.json();
      const { name, date, designer, photographer, description, internalOnly, skuIds, country } = body;
      if (!name) return err("name required");
      const result = await db.prepare(
        "INSERT INTO projects (name, date, designer, photographer, description, internal_only, country) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(name, date || "", designer || "", photographer || "", description || "", internalOnly ? 1 : 0, country || "").run();
      const projectId = result.meta.last_row_id;
      // Insert SKU tags
      if (skuIds && skuIds.length > 0) {
        for (const skuId of skuIds) {
          await db.prepare("INSERT OR IGNORE INTO project_sku_tags (project_id, sku_id) VALUES (?, ?)").bind(projectId, skuId).run();
        }
      }
      return json({ id: projectId, name }, 201);
    }

    if (path.startsWith("/projects/") && !path.includes("/images") && !path.includes("/featured") && method === "PUT") {
      const id = parseInt(path.split("/")[2]);
      const body = await request.json();
      const { name, date, designer, photographer, description, internalOnly, skuIds, country } = body;
      await db.prepare(
        "UPDATE projects SET name = ?, date = ?, designer = ?, photographer = ?, description = ?, internal_only = ?, country = ? WHERE id = ?"
      ).bind(name, date || "", designer || "", photographer || "", description || "", internalOnly ? 1 : 0, country || "", id).run();
      // Re-sync SKU tags
      await db.prepare("DELETE FROM project_sku_tags WHERE project_id = ?").bind(id).run();
      if (skuIds && skuIds.length > 0) {
        for (const skuId of skuIds) {
          await db.prepare("INSERT OR IGNORE INTO project_sku_tags (project_id, sku_id) VALUES (?, ?)").bind(id, skuId).run();
        }
      }
      return json({ id, name });
    }

    // Set featured image for project
    if (path.match(/^\/projects\/\d+\/featured$/) && method === "PUT") {
      const id = parseInt(path.split("/")[2]);
      const body = await request.json();
      const { imageId } = body;
      await db.prepare("UPDATE projects SET featured_image_id = ? WHERE id = ?").bind(imageId || null, id).run();
      return json({ id, featuredImageId: imageId });
    }

    if (path.startsWith("/projects/") && !path.includes("/images") && !path.includes("/featured") && method === "DELETE") {
      const id = parseInt(path.split("/")[2]);
      // Delete images from R2
      if (images) {
        const imgs = await db.prepare("SELECT url FROM project_images WHERE project_id = ?").bind(id).all();
        for (const img of imgs.results) {
          if (img.url.includes("r2.dev") || img.url.includes("/images/")) {
            const key = img.url.split("/").pop();
            try { await images.delete(key); } catch (e) {}
          }
        }
      }
      await db.prepare("DELETE FROM project_images WHERE project_id = ?").bind(id).run();
      await db.prepare("DELETE FROM project_sku_tags WHERE project_id = ?").bind(id).run();
      await db.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
      return json({ deleted: id });
    }

    // ─── PROJECT IMAGES ───

    // Upload image (accepts multipart form data with file)
    if (path.match(/^\/projects\/\d+\/images$/) && method === "POST") {
      const projectId = parseInt(path.split("/")[2]);
      const formData = await request.formData();
      const file = formData.get("file");
      const caption = formData.get("caption") || file.name.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");

      if (!file) return err("file required");

      // Generate unique filename
      const ext = file.name.split(".").pop().toLowerCase();
      const key = `${projectId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

      // Upload to R2
      if (images) {
        await images.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
        });
      }

      // The URL will be served via R2 custom domain or public bucket URL
      // For now, store the R2 key - the frontend constructs the full URL
      const url = `/api/images/${key}`;

      const result = await db.prepare(
        "INSERT INTO project_images (project_id, url, caption) VALUES (?, ?, ?)"
      ).bind(projectId, url, caption).run();

      return json({ id: result.meta.last_row_id, url, caption }, 201);
    }

    // Serve image from R2
    if (path.startsWith("/images/") && method === "GET") {
      const key = path.replace("/images/", "");
      if (images) {
        const object = await images.get(key);
        if (object) {
          return new Response(object.body, {
            headers: {
              "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
              "Cache-Control": "public, max-age=31536000",
            },
          });
        }
      }
      return new Response("Not found", { status: 404 });
    }

    // Delete image
    if (path.match(/^\/projects\/\d+\/images\/\d+$/) && method === "DELETE") {
      const parts = path.split("/");
      const imgId = parseInt(parts[4]);
      // Get URL to delete from R2
      const img = await db.prepare("SELECT url FROM project_images WHERE id = ?").bind(imgId).first();
      if (img && images) {
        const key = img.url.replace("/api/images/", "");
        try { await images.delete(key); } catch (e) {}
      }
      await db.prepare("DELETE FROM project_images WHERE id = ?").bind(imgId).run();
      return json({ deleted: imgId });
    }

    // ─── CATEGORIES ───

    if (path === "/categories" && method === "POST") {
      const body = await request.json();
      const { name } = body;
      if (!name) return err("name required");
      await db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").bind(name).run();
      return json({ name }, 201);
    }

    if (path === "/categories/rename" && method === "PUT") {
      const body = await request.json();
      const { oldName, newName } = body;
      if (!oldName || !newName) return err("oldName and newName required");
      await db.prepare("UPDATE categories SET name = ? WHERE name = ?").bind(newName, oldName).run();
      await db.prepare("UPDATE skus SET category = ? WHERE category = ?").bind(newName, oldName).run();
      return json({ oldName, newName });
    }

    if (path.startsWith("/categories/") && method === "DELETE") {
      const name = decodeURIComponent(path.split("/")[2]);
      // Move SKUs to Uncategorized
      const affected = await db.prepare("SELECT COUNT(*) as count FROM skus WHERE category = ?").bind(name).first();
      if (affected.count > 0) {
        await db.prepare("INSERT OR IGNORE INTO categories (name) VALUES ('Uncategorized')").run();
        await db.prepare("UPDATE skus SET category = 'Uncategorized' WHERE category = ?").bind(name).run();
      }
      await db.prepare("DELETE FROM categories WHERE name = ?").bind(name).run();
      return json({ deleted: name });
    }

    // ─── SETTINGS ───

    if (path === "/settings" && method === "PUT") {
      const body = await request.json();
      for (const [key, value] of Object.entries(body)) {
        await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
      }
      return json({ updated: Object.keys(body) });
    }

    // ─── AUTH ───

    if (path === "/auth/login" && method === "POST") {
      const body = await request.json();
      const { username, password } = body;
      const dbUser = await db.prepare("SELECT value FROM settings WHERE key = 'admin_username'").first();
      const dbPass = await db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
      if (dbUser && dbPass && username === dbUser.value && password === dbPass.value) {
        return json({ success: true });
      }
      return json({ success: false, error: "Invalid credentials" }, 401);
    }

    return err("Not found", 404);

  } catch (e) {
    return json({ error: e.message, stack: e.stack }, 500);
  }
}
