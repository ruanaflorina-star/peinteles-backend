import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import Tesseract from "tesseract.js";
import Anthropic from "@anthropic-ai/sdk";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

/* =======================
   INIT
======================= */
const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

/* =======================
   ANTHROPIC (CLAUDE)
======================= */
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/* =======================
   SYSTEM PROMPTS
======================= */

// Prompt pentru PREVIEW (gratis) - răspuns scurt, teaser
const SYSTEM_PROMPT_PREVIEW = `Ești un asistent expert în explicarea documentelor oficiale românești. 
Analizează documentul și oferă un PREVIEW SCURT care să convingă utilizatorul să plătească pentru analiza completă.

RĂSPUNDE EXACT ÎN ACEST FORMAT (maximum 150 cuvinte total):

📋 **TIP DOCUMENT:** [identifică tipul: ANAF/Amendă/Muncă/Primărie/Altul]

⚠️ **URGENȚĂ:** [DA - ai termen limită! / NU - fără termen imediat]

🔍 **PE SCURT:** [1-2 propoziții despre ce este documentul și de ce l-a primit]

⏰ **TERMEN:** [dacă există, menționează termenul - ex: "15 zile de la comunicare"]

---
💡 *Pentru a vedea analiza completă cu toți pașii, consecințele și căile de atac, deblochează răspunsul complet.*

IMPORTANT: 
- NU da toate detaliile
- NU spune exact ce trebuie să facă
- NU menționa consecințele complete
- Lasă-l curios să vrea să afle mai mult
- Răspunde DOAR în română`;

// Prompt pentru RĂSPUNS COMPLET (după plată)
const SYSTEM_PROMPT_FULL = `Ești un asistent expert în explicarea documentelor oficiale românești pentru cetățeni obișnuiți. Rolul tău este să explici pe înțelesul tuturor ce înseamnă documentele primite de la autorități.

REGULI IMPORTANTE:
1. Răspunde ÎNTOTDEAUNA în limba română
2. Folosește un limbaj simplu, clar, fără termeni juridici complicați
3. Când folosești termeni tehnici, explică-i imediat între paranteze
4. Fii empatic și înțelegător - mulți oameni sunt stresați când primesc astfel de documente
5. Nu oferi sfaturi juridice specifice, ci informații generale de orientare
6. Recomandă consultarea unui specialist pentru cazuri complexe

STRUCTURA RĂSPUNSULUI:

📋 **CE ESTE ACEST DOCUMENT**
Explică pe scurt tipul documentului și cine l-a emis.

❓ **DE CE L-AI PRIMIT**
Explică motivul pentru care persoana a primit acest document.

✅ **CE TREBUIE SĂ FACI**
Pași clari și concreți pe care trebuie să-i urmeze (numerotați).

⏰ **TERMEN LIMITĂ**
Dacă există termene, menționează-le clar și subliniază importanța lor.

⚠️ **CE SE ÎNTÂMPLĂ DACĂ NU FACI NIMIC**
Consecințele posibile ale inacțiunii (dobânzi, penalități, executare, etc.).

⚖️ **DACĂ NU EȘTI DE ACORD**
Opțiuni de contestare sau clarificare, cu pașii necesari.

💡 **SFATURI PRACTICE**
3-5 recomandări utile specifice situației.

📞 **UNDE POȚI CERE AJUTOR**
Instituții sau specialiști relevanți pentru acest tip de document.

---
⚠️ *Informațiile de mai sus sunt orientative și nu înlocuiesc consultanța juridică profesională.*

TIPURI DE DOCUMENTE pe care le poți întâlni:
- ANAF: somații, decizii de impunere, notificări SPV, executări silite
- Amenzi: procese-verbale de contravenție, înștiințări de plată
- Documente de muncă: decizii de concediere, convocări cercetare disciplinară
- Primărie: taxe locale, autorizații, notificări
- Altele: hotărâri judecătorești, contracte, etc.`;

// Prompt pentru CHAT (întrebări follow-up)
const SYSTEM_PROMPT_CHAT = `Ești un asistent expert în explicarea documentelor oficiale românești. 
Utilizatorul a primit deja o analiză a documentului și acum pune întrebări suplimentare.

REGULI:
1. Răspunde DOAR în română
2. Fii concis și direct
3. Dacă nu știi ceva sigur, spune că e mai bine să consulte un specialist
4. Nu repeta toată analiza, răspunde doar la întrebarea pusă
5. Fii empatic și răbdător`;

/* =======================
   HEALTH CHECK
======================= */
app.get("/", (req, res) => {
  res.json({ 
    status: "ok", 
    message: "Peinteles backend v2.0 - Claude AI",
    endpoints: [
      "POST /api/interpret - Analiză document (preview gratuit)",
      "POST /api/interpret-full - Analiză completă (după plată)",
      "POST /api/claude - Chat conversațional"
    ]
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy", version: "2.0" });
});

/* =======================
   HELPER: Extract text from file
======================= */
async function extractTextFromFile(file) {
  const filePath = file.path;
  const mime = file.mimetype;
  let extractedText = "";

  try {
    // PDF
    if (mime === "application/pdf") {
      const buffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(buffer);

      if (pdfData.text && pdfData.text.trim().length > 50) {
        extractedText = pdfData.text;
      } else {
        // PDF scanat - folosim OCR
        const ocr = await Tesseract.recognize(filePath, "eng+ron");
        extractedText = ocr.data.text;
      }
    }

    // IMAGE
    if (mime.startsWith("image/")) {
      const ocr = await Tesseract.recognize(filePath, "eng+ron");
      extractedText = ocr.data.text;
    }

    // TEXT
    if (mime === "text/plain") {
      extractedText = fs.readFileSync(filePath, "utf-8");
    }

  } finally {
    // Cleanup
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  return extractedText;
}

/* =======================
   HELPER: Call Claude API
======================= */
async function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [
      { role: "user", content: userMessage }
    ]
  });

  const textContent = response.content.find(c => c.type === "text");
  return textContent ? textContent.text : "Nu am putut genera un răspuns.";
}

/* =======================
   POST /api/interpret
   Analiză PREVIEW (gratuit)
======================= */
app.post("/api/interpret", upload.single("file"), async (req, res) => {
  try {
    let extractedText = "";

    // Text direct din body
    if (req.body.text && req.body.text.trim() !== "") {
      extractedText = req.body.text;
    }

    // File upload
    if (req.file) {
      extractedText = await extractTextFromFile(req.file);
    }

    if (!extractedText || extractedText.trim() === "") {
      return res.status(400).json({ error: "Nu am putut extrage text din document." });
    }

    // Trimite la Claude pentru PREVIEW
    const interpretation = await callClaude(
      SYSTEM_PROMPT_PREVIEW,
      `Analizează acest document oficial și oferă un preview scurt:\n\n${extractedText}`,
      500 // max tokens pentru preview
    );

    res.json({
      interpretation: interpretation,
      type: "preview",
      message: "Aceasta este o previzualizare. Pentru analiza completă, efectuează plata."
    });

  } catch (err) {
    console.error("Error in /api/interpret:", err);
    res.status(500).json({ error: "Eroare la procesarea documentului. Încearcă din nou." });
  }
});

/* =======================
   POST /api/interpret-full
   Analiză COMPLETĂ (după plată)
======================= */
app.post("/api/interpret-full", upload.single("file"), async (req, res) => {
  try {
    // TODO: Verifică aici dacă utilizatorul a plătit
    // const paymentVerified = await verifyPayment(req.body.paymentId);
    // if (!paymentVerified) {
    //   return res.status(402).json({ error: "Plata nu a fost verificată." });
    // }

    let extractedText = "";

    // Text direct din body
    if (req.body.text && req.body.text.trim() !== "") {
      extractedText = req.body.text;
    }

    // File upload
    if (req.file) {
      extractedText = await extractTextFromFile(req.file);
    }

    if (!extractedText || extractedText.trim() === "") {
      return res.status(400).json({ error: "Nu am putut extrage text din document." });
    }

    // Trimite la Claude pentru RĂSPUNS COMPLET
    const interpretation = await callClaude(
      SYSTEM_PROMPT_FULL,
      `Analizează complet acest document oficial și explică tot ce trebuie să știe utilizatorul:\n\n${extractedText}`,
      4096 // max tokens pentru răspuns complet
    );

    res.json({
      interpretation: interpretation,
      type: "full",
      message: "Analiză completă generată cu succes."
    });

  } catch (err) {
    console.error("Error in /api/interpret-full:", err);
    res.status(500).json({ error: "Eroare la procesarea documentului. Încearcă din nou." });
  }
});

/* =======================
   POST /api/claude
   Chat conversațional (după plată)
======================= */
app.post("/api/claude", async (req, res) => {
  try {
    const { messages, system, image, documentContext } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Mesajele sunt obligatorii." });
    }

    // Construiește mesajele pentru API
    const formattedMessages = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      
      // Verifică dacă ultimul mesaj user are imagine atașată
      const isLastUserMessage = msg.role === "user" && i === messages.length - 1 && image && image.base64;

      if (isLastUserMessage) {
        formattedMessages.push({
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: image.mimeType || "image/jpeg",
                data: image.base64
              }
            },
            {
              type: "text",
              text: msg.content
            }
          ]
        });
      } else {
        formattedMessages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    // Construiește system prompt
    let finalSystemPrompt = system || SYSTEM_PROMPT_CHAT;
    
    // Dacă avem context de document, adaugă-l
    if (documentContext) {
      finalSystemPrompt += `\n\nCONTEXT DOCUMENT ANALIZAT:\n${documentContext}`;
    }

    // Apel Claude
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: finalSystemPrompt,
      messages: formattedMessages
    });

    const textContent = response.content.find(c => c.type === "text");
    const responseText = textContent ? textContent.text : "Nu am putut genera un răspuns.";

    res.json({
      response: responseText,
      usage: response.usage
    });

  } catch (err) {
    console.error("Error in /api/claude:", err);
    
    if (err.status === 401) {
      return res.status(500).json({ error: "Eroare de autentificare API." });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: "Prea multe cereri. Așteaptă un moment." });
    }
    
    res.status(500).json({ error: "Eroare la procesarea cererii." });
  }
});

/* =======================
   POST /api/analyze-image
   Analiză imagine cu Claude Vision
======================= */
app.post("/api/analyze-image", async (req, res) => {
  try {
    const { image, type } = req.body; // type: "preview" sau "full"

    if (!image || !image.base64) {
      return res.status(400).json({ error: "Imaginea este obligatorie." });
    }

    const systemPrompt = type === "full" ? SYSTEM_PROMPT_FULL : SYSTEM_PROMPT_PREVIEW;
    const userPrompt = type === "full" 
      ? "Analizează complet acest document oficial din imagine și explică tot ce trebuie să știe utilizatorul."
      : "Analizează această imagine a unui document oficial și oferă un preview scurt.";

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: type === "full" ? 4096 : 500,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: image.mimeType || "image/jpeg",
                data: image.base64
              }
            },
            {
              type: "text",
              text: userPrompt
            }
          ]
        }
      ]
    });

    const textContent = response.content.find(c => c.type === "text");
    const interpretation = textContent ? textContent.text : "Nu am putut analiza imaginea.";

    res.json({
      interpretation: interpretation,
      type: type || "preview"
    });

  } catch (err) {
    console.error("Error in /api/analyze-image:", err);
    res.status(500).json({ error: "Eroare la analiza imaginii." });
  }
});

/* =======================
   404 Handler
======================= */
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint inexistent" });
});

/* =======================
   START
======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Peinteles Backend v2.0 running on port ${PORT}`);
  console.log(`📋 Using Claude AI (Anthropic)`);
  console.log(`💰 Freemium model: preview + full analysis`);
});
