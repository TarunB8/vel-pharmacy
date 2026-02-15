const express = require("express");
const mysql = require("mysql2");
const bcrypt = require("bcrypt");
const session = require("express-session");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");

require("dotenv").config();

const app = express();

/* ===================== FILE UPLOAD ===================== */
const upload = multer({ dest: "uploads/" });

/* ===================== MIDDLEWARE ===================== */
app.use(express.json());
app.use(express.static("public"));

app.use(
  session({
    secret: "velhealthsecret",
    resave: false,
    saveUninitialized: true,
  })
);

/* ===================== DATABASE POOL ===================== */
const db = mysql.createPool({
  connectionLimit: 10,
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

/* ===================== TEST CONNECTION ===================== */
db.getConnection((err, connection) => {
  if (err) {
    console.error("MySQL pool connection error:", err);
    return;
  }
  console.log("MySQL pool connected");
  connection.release();
});

/* ===================== DATE NORMALIZER ===================== */
function normalizeDate(input) {
  if (!input) return null;

  input = input.toString().trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;

  if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(input)) {
    const [dd, mm, yyyy] = input.split(/[-/]/);
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

/* ===================== REGISTER ===================== */
app.post("/register", async (req, res) => {
  try {
    const hash = await bcrypt.hash(req.body.password, 10);

    db.query(
      `INSERT INTO users(role,name,mobile,email,abha,address,password,credits)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        req.body.role,
        req.body.name || req.body.owner_name,
        req.body.mobile,
        req.body.email,
        req.body.abha,
        req.body.address,
        hash,
        req.body.role === "customer" ? 50 : 0,
      ],
      (err, result) => {
        if (err) return res.json({ message: "Error" });

        if (req.body.role === "pharmacy") {
          db.query(
            `INSERT INTO pharmacies(user_id,pharmacy_name,owner_name,gst)
             VALUES (?,?,?,?)`,
            [
              result.insertId,
              req.body.pharmacy_name,
              req.body.owner_name,
              req.body.gst,
            ]
          );
        }

        res.json({ message: "Registration Successful" });
      }
    );
  } catch {
    res.json({ message: "Error" });
  }
});

/* ===================== LOGIN ===================== */
app.post("/login", (req, res) => {
  db.query(
    `SELECT * FROM users WHERE email=? OR mobile=? OR abha=?`,
    [req.body.user, req.body.user, req.body.user],
    async (err, rows) => {
      if (!rows.length)
        return res.json({ success: false, message: "User not found" });

      const ok = await bcrypt.compare(req.body.password, rows[0].password);
      if (!ok)
        return res.json({ success: false, message: "Invalid password" });

      req.session.user = {
        id: rows[0].id,
        role: rows[0].role,
        name: rows[0].name,
      };

      res.json({ success: true, role: rows[0].role });
    }
  );
});

/* ===================== CUSTOMER DASHBOARD ===================== */
app.get("/customer/dashboard", (req, res) => {
  if (!req.session.user) return res.status(401).json({});

  const uid = req.session.user.id;

  db.query(`SELECT credits FROM users WHERE id=?`, [uid], (e, u) => {
    db.query(
      `SELECT IFNULL(SUM(amount),0) totalSpent FROM purchases WHERE user_id=?`,
      [uid],
      (e2, s) => {
        db.query(
          `SELECT IFNULL(SUM(credit_change),0) used FROM credit_history WHERE user_id=? AND credit_change<0`,
          [uid],
          (e3, c) => {
            db.query(
              `SELECT * FROM purchases WHERE user_id=? ORDER BY created_at DESC LIMIT 5`,
              [uid],
              (e4, p) => {
                res.json({
                  name: req.session.user.name,
                  credits: u[0].credits,
                  totalSpent: s[0].totalSpent,
                  creditsUsed: Math.abs(c[0].used),
                  saved: 100,
                  purchases: p,
                });
              }
            );
          }
        );
      }
    );
  });
});

/* ===================== CREDIT HISTORY ===================== */
app.get("/customer/credits-history", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false });

  const uid = req.session.user.id;

  db.query(`SELECT credits FROM users WHERE id=?`, [uid], (e, b) => {
    db.query(
      `SELECT
        SUM(CASE WHEN credit_change > 0 THEN credit_change ELSE 0 END) earned,
        SUM(CASE WHEN credit_change < 0 THEN credit_change ELSE 0 END) used
       FROM credit_history WHERE user_id=?`,
      [uid],
      (e2, s) => {
        db.query(
          `SELECT description, credit_change, created_at
           FROM credit_history WHERE user_id=? ORDER BY created_at DESC`,
          [uid],
          (e3, h) => {
            res.json({
              success: true,
              balance: b[0].credits,
              earned: s[0].earned || 0,
              used: Math.abs(s[0].used || 0),
              history: h,
            });
          }
        );
      }
    );
  });
});

/* ===================== PHARMACY DASHBOARD ===================== */
app.get("/pharmacy/dashboard", (req, res) => {
  if (!req.session.user || req.session.user.role !== "pharmacy")
    return res.status(401).json({ success: false });

  db.query(
    "SELECT * FROM pharmacies WHERE user_id=?",
    [req.session.user.id],
    (e, p) => {
      if (!p.length) return res.json({ success: false });

      const pid = p[0].id;

      db.query(
        `SELECT
          COUNT(*) total,
          SUM(stock=0) outOfStock,
          SUM(stock BETWEEN 1 AND 10) lowStock,
          SUM(expiry <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)) expiringSoon
         FROM medicines WHERE pharmacy_id=?`,
        [pid],
        (e2, s) => {
          db.query(
            `SELECT * FROM medicines WHERE pharmacy_id=? ORDER BY expiry ASC`,
            [pid],
            (e3, m) => {
              res.json({
                success: true,
                pharmacy: p[0],
                stats: s[0],
                medicines: m,
              });
            }
          );
        }
      );
    }
  );
});

/* ===================== ADD MEDICINE ===================== */
app.post("/pharmacy/add-medicine", (req, res) => {
  if (!req.session.user || req.session.user.role !== "pharmacy")
    return res.status(401).json({ success: false });

  const expiry = normalizeDate(req.body.expiry);

  db.query(
    "SELECT id FROM pharmacies WHERE user_id=?",
    [req.session.user.id],
    (e, p) => {
      if (!p.length) return res.json({ success: false });

      db.query(
        `INSERT INTO medicines
         (pharmacy_id, medicine_name, drug_name, category, stock, price, expiry, notes)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          p[0].id,
          req.body.medicine_name,
          req.body.drug_name,
          req.body.category,
          Number(req.body.stock) || 0,
          Number(req.body.price) || 0,
          expiry,
          req.body.notes,
        ],
        () => res.json({ success: true, message: "Medicine added successfully" })
      );
    }
  );
});

/* ===================== CSV TEMPLATE ===================== */
app.get("/pharmacy/medicine-template", (req, res) => {
  res.setHeader("Content-Disposition", "attachment; filename=medicine_template.csv");
  res.send(
    `medicine_name,drug_name,category,stock_level,price_per_sheet,expiry_date,notes
Paracetamol 500mg,Paracetamol,Tablets,100,25.5,2025-12-31,Keep refrigerated`
  );
});

/* ===================== CSV UPLOAD ===================== */
app.post("/pharmacy/upload-medicines", upload.single("csv"), (req, res) => {
  if (!req.session.user) return res.status(401).json({});

  db.query(
    "SELECT id FROM pharmacies WHERE user_id=?",
    [req.session.user.id],
    (e, p) => {
      if (!p.length) return res.json({ success: false });

      const pid = p[0].id;
      const rows = [];

      fs.createReadStream(req.file.path)
        .pipe(csv())
        .on("data", (r) => rows.push(r))
        .on("end", () => {
          rows.forEach((r) => {
            const expiry = normalizeDate(r.expiry_date);
            if (!expiry) return;

            db.query(
              `INSERT INTO medicines
               (pharmacy_id, medicine_name, drug_name, category, stock, price, expiry, notes)
               VALUES (?,?,?,?,?,?,?,?)`,
              [
                pid,
                r.medicine_name,
                r.drug_name,
                r.category,
                Number(r.stock_level) || 0,
                Number(r.price_per_sheet) || 0,
                expiry,
                r.notes || "",
              ]
            );
          });

          fs.unlinkSync(req.file.path);
          res.json({ success: true, message: "CSV uploaded successfully" });
        });
    }
  );
});

/* ===================== BILLING ===================== */
app.get("/billing/customer/:q", (req, res) => {
  if (!req.session.user || req.session.user.role !== "pharmacy")
    return res.status(401).json({});

  const q = req.params.q;

  db.query(
    `SELECT id,name,credits FROM users
     WHERE role='customer' AND (mobile=? OR email=? OR abha=?)`,
    [q, q, q],
    (e, r) => {
      if (!r.length) return res.json({ success: false });
      res.json({ success: true, customer: r[0] });
    }
  );
});

app.get("/billing/medicines", (req, res) => {
  if (!req.session.user || req.session.user.role !== "pharmacy")
    return res.status(401).json({});

  db.query(
    `SELECT id, medicine_name, price, stock
     FROM medicines
     WHERE pharmacy_id = (
       SELECT id FROM pharmacies WHERE user_id=?
     ) AND stock > 0`,
    [req.session.user.id],
    (e, r) => res.json(r)
  );
});

app.post("/billing/checkout", (req, res) => {
  if (!req.session.user || req.session.user.role !== "pharmacy") {
    return res.status(401).json({ success: false });
  }

  const { customerId, items, creditsUsed, total, paymentMethod } = req.body;

  db.query(
    "SELECT id FROM pharmacies WHERE user_id=?",
    [req.session.user.id],
    (err, p) => {
      if (err || !p.length) {
        console.error("Pharmacy fetch error", err);
        return res.json({ success: false });
      }

      const pharmacyId = p[0].id;

      items.forEach((i) => {
        db.query("UPDATE medicines SET stock = stock - ? WHERE id=?", [i.qty, i.id]);
      });

      if (creditsUsed > 0) {
        db.query("UPDATE users SET credits = credits - ? WHERE id=?", [creditsUsed, customerId]);

        db.query(
          `INSERT INTO credit_history (user_id, credit_change, description)
           VALUES (?,?,?)`,
          [customerId, -creditsUsed, "Used credits for purchase"]
        );
      }

      db.query(
        `INSERT INTO purchases 
         (user_id, pharmacy_id, items, amount, payment_method)
         VALUES (?,?,?,?,?)`,
        [customerId, pharmacyId, items.length, total, paymentMethod],
        (err2, result) => {
          if (err2) {
            console.error("Purchase insert error:", err2);
            return res.json({ success: false });
          }

          res.json({
            success: true,
            invoiceId: result.insertId,
          });
        }
      );
    }
  );
});

/* ===================== INVOICE ===================== */
app.get("/invoice/:id", (req, res) => {
  if (!req.session.user) return res.status(401).json({});

  db.query(
    `
    SELECT p.*, u.name customer_name, ph.pharmacy_name
    FROM purchases p
    JOIN users u ON u.id = p.user_id
    JOIN pharmacies ph ON ph.id = p.pharmacy_id
    WHERE p.id = ?
    `,
    [req.params.id],
    (e, r) => {
      if (!r.length) return res.json({ success: false });
      res.json({ success: true, invoice: r[0] });
    }
  );
});

/* ===================== SERVER ===================== */
app.listen(3000, () => console.log("Server running on 3000"));