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

// Extract authenticated user email from Cloudflare Access header
function getUserEmail(request) {
  return request.headers.get("Cf-Access-Authenticated-User-Email") || "anonymous";
}

// Log an activity event (never fails the main request)
async function logActivity(db, email, action, entityType, entityId, entityName, details, isAdmin) {
  try {
    await db.prepare(
      "INSERT INTO activity_log (user_email, action, entity_type, entity_id, entity_name, details, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      email || "anonymous",
      action,
      entityType || null,
      entityId != null ? String(entityId) : null,
      entityName || null,
      details || null,
      isAdmin ? 1 : 0
    ).run();
  } catch (e) {
    // Silently fail — never block the user's action over a log error
  }
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
      const [cats, skus, projects, projectSkuTags, projectImages, imageSkuTags, settings] = await Promise.all([
        db.prepare("SELECT * FROM categories ORDER BY name").all(),
        db.prepare("SELECT * FROM skus ORDER BY code").all(),
        db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all(),
        db.prepare("SELECT * FROM project_sku_tags").all(),
        db.prepare("SELECT * FROM project_images ORDER BY created_at").all(),
        db.prepare("SELECT * FROM image_sku_tags").all(),
        db.prepare("SELECT * FROM settings").all(),
      ]);

      // Assemble projects with their sku tags and images (each image has its own skuIds)
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
          .map((img) => ({
            id: img.id,
            url: img.url,
            caption: img.caption,
            thumbnailUrl: img.thumbnail_url || "",
            skuIds: imageSkuTags.results.filter((t) => t.image_id === img.id).map((t) => t.sku_id),
          })),
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
      await logActivity(db, getUserEmail(request), "create_sku", "sku", result.meta.last_row_id, code.toUpperCase(), name + " (" + (category || "Uncategorized") + ")", true);
      return json({ id: result.meta.last_row_id, code: code.toUpperCase(), name, category: category || "Uncategorized" }, 201);
    }

    if (path.startsWith("/skus/") && method === "PUT") {
      const id = parseInt(path.split("/")[2]);
      const body = await request.json();
      const { code, name, category } = body;
      await db.prepare("UPDATE skus SET code = ?, name = ?, category = ? WHERE id = ?").bind(code.toUpperCase(), name, category, id).run();
      await logActivity(db, getUserEmail(request), "update_sku", "sku", id, code.toUpperCase(), name + " (" + category + ")", true);
      return json({ id, code: code.toUpperCase(), name, category });
    }

    if (path.startsWith("/skus/") && method === "DELETE") {
      const id = parseInt(path.split("/")[2]);
      const existing = await db.prepare("SELECT code, name FROM skus WHERE id = ?").bind(id).first();
      await db.prepare("DELETE FROM project_sku_tags WHERE sku_id = ?").bind(id).run();
      await db.prepare("DELETE FROM image_sku_tags WHERE sku_id = ?").bind(id).run();
      await db.prepare("DELETE FROM skus WHERE id = ?").bind(id).run();
      await logActivity(db, getUserEmail(request), "delete_sku", "sku", id, existing?.code || String(id), existing?.name || "", true);
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
      await logActivity(db, getUserEmail(request), "bulk_import_skus", "sku", null, null, "Added " + added.length + ", updated " + updated.length, true);
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
      await logActivity(db, getUserEmail(request), "create_project", "project", projectId, name, "Tagged " + (skuIds?.length || 0) + " SKUs", true);
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
      await logActivity(db, getUserEmail(request), "update_project", "project", id, name, "Tagged " + (skuIds?.length || 0) + " SKUs", true);
      return json({ id, name });
    }

    // Set featured image for project
    if (path.match(/^\/projects\/\d+\/featured$/) && method === "PUT") {
      const id = parseInt(path.split("/")[2]);
      const body = await request.json();
      const { imageId } = body;
      await db.prepare("UPDATE projects SET featured_image_id = ? WHERE id = ?").bind(imageId || null, id).run();
      const proj = await db.prepare("SELECT name FROM projects WHERE id = ?").bind(id).first();
      await logActivity(db, getUserEmail(request), "set_cover_image", "project", id, proj?.name || "", "Cover image: " + imageId, true);
      return json({ id, featuredImageId: imageId });
    }

    if (path.startsWith("/projects/") && !path.includes("/images") && !path.includes("/featured") && method === "DELETE") {
      const id = parseInt(path.split("/")[2]);
      const proj = await db.prepare("SELECT name FROM projects WHERE id = ?").bind(id).first();
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
      // Clean up image_sku_tags for all images in this project
      await db.prepare("DELETE FROM image_sku_tags WHERE image_id IN (SELECT id FROM project_images WHERE project_id = ?)").bind(id).run();
      await db.prepare("DELETE FROM project_images WHERE project_id = ?").bind(id).run();
      await db.prepare("DELETE FROM project_sku_tags WHERE project_id = ?").bind(id).run();
      await db.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
      await logActivity(db, getUserEmail(request), "delete_project", "project", id, proj?.name || String(id), null, true);
      return json({ deleted: id });
    }

    // ─── PROJECT IMAGES ───

    // Upload image (accepts multipart form data with file)
    if (path.match(/^\/projects\/\d+\/images$/) && method === "POST") {
      const projectId = parseInt(path.split("/")[2]);
      const formData = await request.formData();
      const file = formData.get("file");
      const thumbnail = formData.get("thumbnail");
      const caption = formData.get("caption") || file.name.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");

      if (!file) return err("file required");

      // Generate unique filename
      const ext = file.name.split(".").pop().toLowerCase();
      const baseName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const key = `${projectId}/${baseName}.${ext}`;
      const thumbKey = `${projectId}/thumb_${baseName}.jpg`;

      // Upload main image to R2
      if (images) {
        await images.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
        });
        // Upload thumbnail if provided
        if (thumbnail) {
          await images.put(thumbKey, thumbnail.stream(), {
            httpMetadata: { contentType: "image/jpeg" },
          });
        }
      }

      const url = `/api/images/${key}`;
      const thumbnailUrl = thumbnail ? `/api/images/${thumbKey}` : "";

      const result = await db.prepare(
        "INSERT INTO project_images (project_id, url, caption, thumbnail_url) VALUES (?, ?, ?, ?)"
      ).bind(projectId, url, caption, thumbnailUrl).run();

      const proj = await db.prepare("SELECT name FROM projects WHERE id = ?").bind(projectId).first();
      await logActivity(db, getUserEmail(request), "upload_image", "image", result.meta.last_row_id, proj?.name || String(projectId), caption, true);

      return json({ id: result.meta.last_row_id, url, thumbnailUrl, caption }, 201);
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

    // Update image caption and/or SKU tags
    if (path.match(/^\/projects\/\d+\/images\/\d+$/) && method === "PUT") {
      const parts = path.split("/");
      const projId = parseInt(parts[2]);
      const imgId = parseInt(parts[4]);
      const body = await request.json();
      const { caption, skuIds } = body;
      if (caption !== undefined) {
        await db.prepare("UPDATE project_images SET caption = ? WHERE id = ?").bind(caption || "", imgId).run();
        await logActivity(db, getUserEmail(request), "update_image_caption", "image", imgId, caption || "", null, true);
      }
      if (skuIds !== undefined) {
        // Re-sync image SKU tags
        await db.prepare("DELETE FROM image_sku_tags WHERE image_id = ?").bind(imgId).run();
        if (skuIds.length > 0) {
          for (const skuId of skuIds) {
            await db.prepare("INSERT OR IGNORE INTO image_sku_tags (image_id, sku_id) VALUES (?, ?)").bind(imgId, skuId).run();
          }
        }
        await logActivity(db, getUserEmail(request), "tag_image_skus", "image", imgId, null, "Tagged " + skuIds.length + " SKUs", true);
      }
      return json({ id: imgId, caption, skuIds });
    }

    // Delete image
    if (path.match(/^\/projects\/\d+\/images\/\d+$/) && method === "DELETE") {
      const parts = path.split("/");
      const imgId = parseInt(parts[4]);
      // Get URLs to delete from R2
      const img = await db.prepare("SELECT url, thumbnail_url, caption FROM project_images WHERE id = ?").bind(imgId).first();
      if (img && images) {
        const key = img.url.replace("/api/images/", "");
        try { await images.delete(key); } catch (e) {}
        if (img.thumbnail_url) {
          const thumbKey = img.thumbnail_url.replace("/api/images/", "");
          try { await images.delete(thumbKey); } catch (e) {}
        }
      }
      await db.prepare("DELETE FROM image_sku_tags WHERE image_id = ?").bind(imgId).run();
      await db.prepare("DELETE FROM project_images WHERE id = ?").bind(imgId).run();
      await logActivity(db, getUserEmail(request), "delete_image", "image", imgId, img?.caption || String(imgId), null, true);
      return json({ deleted: imgId });
    }

    // ─── CATEGORIES ───

    if (path === "/categories" && method === "POST") {
      const body = await request.json();
      const { name } = body;
      if (!name) return err("name required");
      await db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").bind(name).run();
      await logActivity(db, getUserEmail(request), "create_category", "category", null, name, null, true);
      return json({ name }, 201);
    }

    if (path === "/categories/rename" && method === "PUT") {
      const body = await request.json();
      const { oldName, newName } = body;
      if (!oldName || !newName) return err("oldName and newName required");
      await db.prepare("UPDATE categories SET name = ? WHERE name = ?").bind(newName, oldName).run();
      await db.prepare("UPDATE skus SET category = ? WHERE category = ?").bind(newName, oldName).run();
      await logActivity(db, getUserEmail(request), "rename_category", "category", null, newName, "Was: " + oldName, true);
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
      await logActivity(db, getUserEmail(request), "delete_category", "category", null, name, affected.count > 0 ? "Moved " + affected.count + " SKUs to Uncategorized" : null, true);
      return json({ deleted: name });
    }

    // ─── SETTINGS ───

    if (path === "/settings" && method === "PUT") {
      const body = await request.json();
      for (const [key, value] of Object.entries(body)) {
        await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
      }
      const keys = Object.keys(body);
      const passwordChanged = keys.includes("admin_password");
      const logoChanged = keys.includes("logo");
      let detail = "Updated: " + keys.join(", ");
      if (passwordChanged) detail = "Admin password changed";
      else if (logoChanged) detail = "Logo updated";
      await logActivity(db, getUserEmail(request), "update_settings", "settings", null, null, detail, true);
      return json({ updated: keys });
    }

    // ─── AUTH ───

    if (path === "/auth/login" && method === "POST") {
      const body = await request.json();
      const { username, password } = body;
      const dbUser = await db.prepare("SELECT value FROM settings WHERE key = 'admin_username'").first();
      const dbPass = await db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
      if (dbUser && dbPass && username === dbUser.value && password === dbPass.value) {
        await logActivity(db, getUserEmail(request), "admin_login", null, null, null, "Username: " + username, true);
        return json({ success: true });
      }
      await logActivity(db, getUserEmail(request), "admin_login_failed", null, null, null, "Username: " + username, false);
      return json({ success: false, error: "Invalid credentials" }, 401);
    }

    // ─── MARKETING DRAFTS ───

    // List all drafts
    if (path === "/marketing/drafts" && method === "GET") {
      const result = await db.prepare("SELECT id, project_id, title, thumbnail, created_at, updated_at FROM marketing_drafts ORDER BY updated_at DESC").all();
      return json({
        drafts: result.results.map(d => ({
          id: d.id,
          projectId: d.project_id,
          title: d.title,
          thumbnail: d.thumbnail,
          createdAt: d.created_at,
          updatedAt: d.updated_at,
        }))
      });
    }

    // Get a single draft (with full state)
    if (path.match(/^\/marketing\/drafts\/\d+$/) && method === "GET") {
      const id = parseInt(path.split("/")[3]);
      const d = await db.prepare("SELECT * FROM marketing_drafts WHERE id = ?").bind(id).first();
      if (!d) return err("Draft not found", 404);
      return json({
        id: d.id,
        projectId: d.project_id,
        title: d.title,
        state: JSON.parse(d.state || "{}"),
        thumbnail: d.thumbnail,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
      });
    }

    // Create a new draft
    if (path === "/marketing/drafts" && method === "POST") {
      const body = await request.json();
      const { projectId, title, state, thumbnail } = body;
      if (!title || !state) return err("title and state required");
      const result = await db.prepare(
        "INSERT INTO marketing_drafts (project_id, created_by, title, state, thumbnail) VALUES (?, ?, ?, ?, ?)"
      ).bind(projectId || null, getUserEmail(request), title, JSON.stringify(state), thumbnail || null).run();
      await logActivity(db, getUserEmail(request), "create_draft", "draft", result.meta.last_row_id, title, null, true);
      return json({ id: result.meta.last_row_id }, 201);
    }

    // Update a draft
    if (path.match(/^\/marketing\/drafts\/\d+$/) && method === "PUT") {
      const id = parseInt(path.split("/")[3]);
      const body = await request.json();
      const { title, state, thumbnail } = body;
      await db.prepare(
        "UPDATE marketing_drafts SET title = ?, state = ?, thumbnail = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(title, JSON.stringify(state), thumbnail || null, id).run();
      await logActivity(db, getUserEmail(request), "update_draft", "draft", id, title, null, true);
      return json({ id, updated: true });
    }

    // Delete a draft
    if (path.match(/^\/marketing\/drafts\/\d+$/) && method === "DELETE") {
      const id = parseInt(path.split("/")[3]);
      const d = await db.prepare("SELECT title FROM marketing_drafts WHERE id = ?").bind(id).first();
      await db.prepare("DELETE FROM marketing_drafts WHERE id = ?").bind(id).run();
      await logActivity(db, getUserEmail(request), "delete_draft", "draft", id, d?.title || String(id), null, true);
      return json({ deleted: id });
    }

    // ─── ACTIVITY LOG ───

    // Log a client-side event (view, download)
    if (path === "/log" && method === "POST") {
      const body = await request.json();
      const { action, entityType, entityId, entityName, details } = body;
      if (!action) return err("action required");
      // Only allow specific client-side actions
      const allowed = ["view_project", "download_image", "download_project_all", "search"];
      if (!allowed.includes(action)) return err("Invalid action");
      await logActivity(db, getUserEmail(request), action, entityType, entityId, entityName, details, false);
      return json({ logged: true });
    }

    // Get activity log entries with filters
    if (path === "/log" && method === "GET") {
      const url = new URL(request.url);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 1000);
      const offset = parseInt(url.searchParams.get("offset") || "0");
      const userFilter = url.searchParams.get("user") || "";
      const actionFilter = url.searchParams.get("action") || "";
      const adminOnly = url.searchParams.get("adminOnly") === "1";
      const dateFrom = url.searchParams.get("from") || "";
      const dateTo = url.searchParams.get("to") || "";
      const search = url.searchParams.get("q") || "";

      let where = [];
      let binds = [];
      if (userFilter) { where.push("user_email LIKE ?"); binds.push("%" + userFilter + "%"); }
      if (actionFilter) { where.push("action = ?"); binds.push(actionFilter); }
      if (adminOnly) { where.push("is_admin = 1"); }
      if (dateFrom) { where.push("created_at >= ?"); binds.push(dateFrom); }
      if (dateTo) { where.push("created_at <= ?"); binds.push(dateTo); }
      if (search) {
        where.push("(entity_name LIKE ? OR details LIKE ? OR user_email LIKE ?)");
        binds.push("%" + search + "%", "%" + search + "%", "%" + search + "%");
      }
      const whereSql = where.length > 0 ? " WHERE " + where.join(" AND ") : "";

      const countResult = await db.prepare("SELECT COUNT(*) as total FROM activity_log" + whereSql).bind(...binds).first();
      const result = await db.prepare("SELECT * FROM activity_log" + whereSql + " ORDER BY created_at DESC LIMIT ? OFFSET ?").bind(...binds, limit, offset).all();

      return json({
        total: countResult.total,
        offset,
        limit,
        entries: result.results.map(e => ({
          id: e.id,
          userEmail: e.user_email,
          action: e.action,
          entityType: e.entity_type,
          entityId: e.entity_id,
          entityName: e.entity_name,
          details: e.details,
          isAdmin: !!e.is_admin,
          createdAt: e.created_at,
        })),
      });
    }

    return err("Not found", 404);

  } catch (e) {
    return json({ error: e.message, stack: e.stack }, 500);
  }
}
