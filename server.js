const path = require("path");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const morgan = require("morgan");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(morgan("dev"));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "scrap-business-manager-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }
  })
);

const ITEM_TYPES = [
  "Compressor Scrap",
  "Bara Compressor",
  "Bottle Compressor",
  "Dangar Compressor"
];

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  return next();
}

function getUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
}

function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function getOrCreateParty(name) {
  if (!name) {
    return null;
  }
  const existing = db.prepare("SELECT * FROM parties WHERE name = ?").get(name.trim());
  if (existing) {
    return existing;
  }
  const info = db.prepare("INSERT INTO parties (name) VALUES (?)").run(name.trim());
  return db.prepare("SELECT * FROM parties WHERE id = ?").get(info.lastInsertRowid);
}

function fetchTransactions(userId, includeDeleted = true) {
  const clause = includeDeleted ? "" : "AND transactions.deleted_at IS NULL";
  return db
    .prepare(
      `
        SELECT transactions.*, parties.name AS party_name
        FROM transactions
        LEFT JOIN parties ON parties.id = transactions.party_id
        WHERE transactions.user_id = ? ${clause}
        ORDER BY datetime(transactions.created_at) DESC
      `
    )
    .all(userId);
}

function calculateCapital(user, transactions) {
  let capital = Number(user.initial_capital || 0);
  transactions.forEach((entry) => {
    if (entry.deleted_at) {
      return;
    }
    if (entry.type === "purchase") {
      capital -= Number(entry.amount || 0);
    }
    if (entry.type === "sale") {
      capital += Number(entry.amount || 0);
    }
    if (entry.type === "payment") {
      if (entry.payment_direction === "receive") {
        capital += Number(entry.amount || 0);
      }
      if (entry.payment_direction === "pay") {
        capital -= Number(entry.amount || 0);
      }
    }
  });
  return capital;
}

function calculateStock(transactions) {
  const stock = {};
  ITEM_TYPES.forEach((item) => {
    stock[item] = 0;
  });
  transactions.forEach((entry) => {
    if (entry.deleted_at) {
      return;
    }
    if (!entry.item_type) {
      return;
    }
    if (entry.type === "purchase") {
      stock[entry.item_type] = (stock[entry.item_type] || 0) + Number(entry.weight || 0);
    }
    if (entry.type === "sale") {
      stock[entry.item_type] = (stock[entry.item_type] || 0) - Number(entry.weight || 0);
    }
  });
  return stock;
}

app.get("/", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/dashboard");
  }
  return res.redirect("/login");
});

app.get("/register", (req, res) => {
  res.render("register", { error: null });
});

app.post("/register", (req, res) => {
  const { name, email, password, initialCapital } = req.body;
  if (!name || !email || !password) {
    return res.render("register", { error: "All fields are required." });
  }
  if (getUserByEmail(email)) {
    return res.render("register", { error: "Email already registered." });
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, initial_capital) VALUES (?, ?, ?, ?)")
    .run(name.trim(), email.trim(), passwordHash, Number(initialCapital || 0));
  req.session.userId = info.lastInsertRowid;
  return res.redirect("/dashboard");
});

app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  const user = getUserByEmail(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render("login", { error: "Invalid credentials." });
  }
  req.session.userId = user.id;
  return res.redirect("/dashboard");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/dashboard", requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  const transactions = fetchTransactions(user.id, true);
  const capital = calculateCapital(user, transactions);
  const stock = calculateStock(transactions);
  const parties = db.prepare("SELECT * FROM parties ORDER BY name").all();

  res.render("dashboard", {
    user,
    transactions,
    capital,
    stock,
    parties,
    itemTypes: ITEM_TYPES
  });
});

app.post("/capital", requireAuth, (req, res) => {
  const { initialCapital } = req.body;
  db.prepare("UPDATE users SET initial_capital = ? WHERE id = ?").run(Number(initialCapital || 0), req.session.userId);
  return res.redirect("/dashboard");
});

app.post("/transactions", requireAuth, (req, res) => {
  const { type, partyName, itemType, weight, amount, paymentDirection, notes } = req.body;
  if (!type || !amount) {
    return res.redirect("/dashboard");
  }

  const party = getOrCreateParty(partyName);
  db.prepare(
    `
      INSERT INTO transactions
        (user_id, party_id, type, item_type, weight, amount, payment_direction, notes, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `
  ).run(
    req.session.userId,
    party ? party.id : null,
    type,
    itemType || null,
    weight ? Number(weight) : null,
    Number(amount),
    paymentDirection || null,
    notes || null
  );

  return res.redirect("/dashboard");
});

app.post("/transactions/:id/delete", requireAuth, (req, res) => {
  db.prepare("UPDATE transactions SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.session.userId);
  return res.redirect("/dashboard");
});

app.post("/transactions/:id/restore", requireAuth, (req, res) => {
  db.prepare("UPDATE transactions SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.session.userId);
  return res.redirect("/dashboard");
});

app.post("/transactions/:id/edit", requireAuth, (req, res) => {
  const { type, partyName, itemType, weight, amount, paymentDirection, notes } = req.body;
  const party = getOrCreateParty(partyName);
  db.prepare(
    `
      UPDATE transactions
      SET type = ?,
          party_id = ?,
          item_type = ?,
          weight = ?,
          amount = ?,
          payment_direction = ?,
          notes = ?,
          updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `
  ).run(
    type,
    party ? party.id : null,
    itemType || null,
    weight ? Number(weight) : null,
    Number(amount),
    paymentDirection || null,
    notes || null,
    req.params.id,
    req.session.userId
  );

  return res.redirect("/dashboard");
});

app.get("/parties/:id", requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  const party = db.prepare("SELECT * FROM parties WHERE id = ?").get(req.params.id);
  if (!party) {
    return res.redirect("/dashboard");
  }
  const transactions = db
    .prepare(
      `
        SELECT transactions.*, parties.name AS party_name
        FROM transactions
        LEFT JOIN parties ON parties.id = transactions.party_id
        WHERE transactions.user_id = ? AND transactions.party_id = ?
        ORDER BY datetime(transactions.created_at) DESC
      `
    )
    .all(user.id, party.id);

  const capital = calculateCapital(user, fetchTransactions(user.id, true));
  const stock = calculateStock(fetchTransactions(user.id, true));

  res.render("party", {
    user,
    party,
    transactions,
    capital,
    stock,
    itemTypes: ITEM_TYPES
  });
});

app.listen(PORT, () => {
  console.log(`Scrap Business Manager running on http://localhost:${PORT}`);
});
