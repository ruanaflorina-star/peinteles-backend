import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import Tesseract from "tesseract.js";
import Anthropic from "@anthropic-ai/sdk";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

/* =======================
   INIT
======================= */
const app = express();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads/";
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (req, file, cb) => {
    // Accept PDFs, images, and text files
    const allowedMimes = [
      'application/pdf',
      'image/jpeg',
      'image/jpg', 
      'image/png',
      'image/gif',
      'image/webp',
      'image/bmp',
      'image/tiff',
      'text/plain'
    ];
    
    if (allowedMimes.includes(file.mimetype) || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error(`Tip de fișier neacceptat: ${file.mimetype}`), false);
    }
  }
});

app.use(cors({
  origin: [
    "https://peinteles.ro",
    "https://www.peinteles.ro",
    "http://localhost:3000",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

// Handle preflight requests explicitly
app.options('*', cors());

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
    message: "Peinteles backend v2.1 - Claude AI + OCR",
    features: [
      "PDF text extraction",
      "PDF scanned (OCR)",
      "Image OCR (JPG, PNG, etc.)",
      "Claude Vision for images",
      "Text files"
    ],
    endpoints: [
      "POST /api/interpret - Analiză document (preview gratuit)",
      "POST /api/interpret-full - Analiză completă (după plată)",
      "POST /api/claude - Chat conversațional"
    ]
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy", version: "2.1" });
});

/* =======================
   HELPER: Extract text from file using multiple methods
======================= */
async function extractTextFromFile(file) {
  const filePath = file.path;
  const mime = file.mimetype;
  const originalName = file.originalname || "document";
  
  console.log(`Processing file: ${originalName} (${mime})`);
  
  let extractedText = "";
  let method = "unknown";

  try {
    // ============ PDF FILES ============
    if (mime === "application/pdf") {
      console.log("Attempting PDF text extraction...");
      
      try {
        const buffer = fs.readFileSync(filePath);
        const pdfData = await pdfParse(buffer);
        
        // Check if we got meaningful text
        const text = pdfData.text ? pdfData.text.trim() : "";
        
        if (text.length > 100) {
          // Good amount of text - it's a text-based PDF
          extractedText = text;
          method = "pdf-text";
          console.log(`PDF text extraction successful: ${text.length} chars`);
        } else {
          // Very little or no text - probably scanned
          // Return empty text and flag for Vision processing
          console.log("PDF appears to be scanned, will use Claude Vision...");
          extractedText = "";
          method = "pdf-scanned-vision";
        }
      } catch (pdfErr) {
        console.error("PDF parsing failed:", pdfErr.message);
        // If PDF parsing fails, flag for Vision
        extractedText = "";
        method = "pdf-error-vision";
      }
    }
    
    // ============ IMAGE FILES ============
    else if (mime.startsWith("image/")) {
      console.log("Processing image with OCR...");
      
      const ocr = await Tesseract.recognize(filePath, "ron+eng", {
        logger: m => {
          if (m.status === 'recognizing text') {
            console.log(`OCR progress: ${Math.round(m.progress * 100)}%`);
          }
        }
      });
      
      extractedText = ocr.data.text;
      method = "image-ocr";
      console.log(`Image OCR successful: ${extractedText.length} chars`);
    }
    
    // ============ TEXT FILES ============
    else if (mime === "text/plain") {
      extractedText = fs.readFileSync(filePath, "utf-8");
      method = "text-file";
      console.log(`Text file read: ${extractedText.length} chars`);
    }
    
    // ============ UNKNOWN TYPE ============
    else {
      console.log(`Unknown mime type: ${mime}, trying OCR as fallback...`);
      try {
        const ocr = await Tesseract.recognize(filePath, "ron+eng");
        extractedText = ocr.data.text;
        method = "unknown-ocr";
      } catch (ocrErr) {
        console.error("OCR fallback failed:", ocrErr.message);
      }
    }

  } catch (err) {
    console.error(`Error processing file: ${err.message}`);
    throw err;
  } finally {
    // Cleanup - delete uploaded file
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log("Cleaned up temporary file");
      }
    } catch (cleanupErr) {
      console.error("Cleanup error:", cleanupErr.message);
    }
  }

  console.log(`Extraction complete. Method: ${method}, Length: ${extractedText.length}`);
  
  return {
    text: extractedText.trim(),
    method: method
  };
}

/* =======================
   HELPER: Call Claude API with text
======================= */
async function callClaudeWithText(systemPrompt, userMessage, maxTokens = 1024) {
  console.log("Calling Claude API (text)...");
  
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
   HELPER: Call Claude API with image (Vision)
======================= */
async function callClaudeWithImage(systemPrompt, imageBase64, mimeType, userMessage, maxTokens = 1024) {
  console.log("Calling Claude API (vision)...");
  
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [
      { 
        role: "user", 
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType,
              data: imageBase64
            }
          },
          {
            type: "text",
            text: userMessage
          }
        ]
      }
    ]
  });

  const textContent = response.content.find(c => c.type === "text");
  return textContent ? textContent.text : "Nu am putut genera un răspuns.";
}

/* =======================
   HELPER: Call Claude API with PDF document
======================= */
async function callClaudeWithPDF(systemPrompt, pdfBase64, userMessage, maxTokens = 1024) {
  console.log("Calling Claude API (PDF document)...");
  
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [
      { 
        role: "user", 
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfBase64
            }
          },
          {
            type: "text",
            text: userMessage
          }
        ]
      }
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
  console.log("\n=== NEW REQUEST: /api/interpret ===");
  
  try {
    let extractedText = "";
    let extractionMethod = "direct-text";
    let useVision = false;
    let imageBase64 = null;
    let imageMimeType = null;
    let pdfBase64 = null;

    // Check for direct text input
    if (req.body.text && req.body.text.trim() !== "" && !req.body.text.startsWith("[")) {
      extractedText = req.body.text.trim();
      console.log(`Received direct text: ${extractedText.length} chars`);
    }

    // Check for file upload
    if (req.file) {
      console.log(`Received file: ${req.file.originalname} (${req.file.mimetype}, ${req.file.size} bytes)`);
      
      const mime = req.file.mimetype;
      
      // For images, we have two options:
      // 1. Use OCR (Tesseract) - works offline but less accurate
      // 2. Use Claude Vision - more accurate but costs more
      // We'll try OCR first, and if result is poor, use Vision
      
      if (mime.startsWith("image/")) {
        // Read image for potential Vision use
        const imageBuffer = fs.readFileSync(req.file.path);
        imageBase64 = imageBuffer.toString('base64');
        imageMimeType = mime;
        
        // Try OCR first
        const result = await extractTextFromFile(req.file);
        extractedText = result.text;
        extractionMethod = result.method;
        
        // If OCR result is poor (too short or mostly garbage), use Vision
        if (extractedText.length < 50 || extractedText.split(/\s+/).length < 10) {
          console.log("OCR result poor, will use Claude Vision instead");
          useVision = true;
          extractedText = ""; // Will use Vision
        }
      } else if (mime === "application/pdf") {
        // Read PDF first (before extraction might delete it)
        const pdfBuffer = fs.readFileSync(req.file.path);
        pdfBase64 = pdfBuffer.toString('base64');
        
        // For PDFs, try text extraction first
        const result = await extractTextFromFile(req.file);
        extractedText = result.text;
        extractionMethod = result.method;
        
        // If PDF is scanned (no text extracted), use Claude Vision with PDF
        if (extractionMethod.includes("vision") || extractedText.length < 50) {
          console.log("PDF is scanned, will use Claude Vision");
          useVision = true;
          extractedText = "";
        }
      } else {
        // For text files, use regular extraction
        const result = await extractTextFromFile(req.file);
        extractedText = result.text;
        extractionMethod = result.method;
      }
    }

    // Validate we have something to analyze
    if (!extractedText && !useVision) {
      return res.status(400).json({ 
        error: "Nu am putut extrage text din document. Încearcă să faci o poză mai clară sau să copiezi textul manual." 
      });
    }

    console.log(`Extraction method: ${extractionMethod}, Text length: ${extractedText.length}, Use Vision: ${useVision}`);

    // Call Claude for analysis
    let interpretation;
    
    if (useVision && pdfBase64) {
      // Use Claude Vision for scanned PDF
      console.log("Using Claude Vision for scanned PDF...");
      interpretation = await callClaudeWithPDF(
        SYSTEM_PROMPT_PREVIEW,
        pdfBase64,
        "Analizează acest document PDF oficial românesc și oferă un preview scurt conform instrucțiunilor.",
        600
      );
    } else if (useVision && imageBase64) {
      // Use Claude Vision for image analysis
      interpretation = await callClaudeWithImage(
        SYSTEM_PROMPT_PREVIEW,
        imageBase64,
        imageMimeType,
        "Analizează această imagine a unui document oficial românesc și oferă un preview scurt conform instrucțiunilor.",
        600
      );
    } else {
      // Use regular text analysis
      interpretation = await callClaudeWithText(
        SYSTEM_PROMPT_PREVIEW,
        `Analizează acest document oficial și oferă un preview scurt:\n\n${extractedText}`,
        600
      );
    }

    console.log("Analysis complete, sending response");

    res.json({
      interpretation: interpretation,
      type: "preview",
      extractionMethod: extractionMethod,
      textLength: extractedText.length,
      message: "Aceasta este o previzualizare. Pentru analiza completă, efectuează plata."
    });

  } catch (err) {
    console.error("Error in /api/interpret:", err);
    
    // Handle specific errors
    if (err.message?.includes("Tip de fișier neacceptat")) {
      return res.status(400).json({ error: err.message });
    }
    
    res.status(500).json({ 
      error: "Eroare la procesarea documentului. Te rog încearcă din nou sau copiază textul manual." 
    });
  }
});

/* =======================
   POST /api/interpret-full
   Analiză COMPLETĂ (după plată)
======================= */
app.post("/api/interpret-full", upload.single("file"), async (req, res) => {
  console.log("\n=== NEW REQUEST: /api/interpret-full ===");
  
  try {
    // TODO: Verifică plata aici
    // const paymentVerified = await verifyPayment(req.body.paymentId);
    // if (!paymentVerified) {
    //   return res.status(402).json({ error: "Plata nu a fost verificată." });
    // }

    let extractedText = "";
    let useVision = false;
    let imageBase64 = null;
    let imageMimeType = null;
    let pdfBase64 = null;

    // Check for direct text input
    if (req.body.text && req.body.text.trim() !== "" && !req.body.text.startsWith("[")) {
      extractedText = req.body.text.trim();
    }

    // Check for file upload
    if (req.file) {
      const mime = req.file.mimetype;
      
      if (mime.startsWith("image/")) {
        const imageBuffer = fs.readFileSync(req.file.path);
        imageBase64 = imageBuffer.toString('base64');
        imageMimeType = mime;
        
        const result = await extractTextFromFile(req.file);
        extractedText = result.text;
        
        if (extractedText.length < 50) {
          useVision = true;
          extractedText = "";
        }
      } else if (mime === "application/pdf") {
        // Read PDF first (before extraction might delete it)
        const pdfBuffer = fs.readFileSync(req.file.path);
        pdfBase64 = pdfBuffer.toString('base64');
        
        // For PDFs, try text extraction first
        const result = await extractTextFromFile(req.file);
        extractedText = result.text;
        
        // If PDF is scanned (no text extracted), use Claude Vision with PDF
        if (result.method.includes("vision") || extractedText.length < 50) {
          console.log("PDF is scanned, will use Claude Vision for full analysis");
          useVision = true;
          extractedText = "";
        }
      } else {
        const result = await extractTextFromFile(req.file);
        extractedText = result.text;
      }
    }

    if (!extractedText && !useVision) {
      return res.status(400).json({ 
        error: "Nu am putut extrage text din document." 
      });
    }

    // Call Claude for full analysis
    let interpretation;
    
    if (useVision && pdfBase64) {
      // Use Claude Vision for scanned PDF
      console.log("Using Claude Vision for scanned PDF (full analysis)...");
      interpretation = await callClaudeWithPDF(
        SYSTEM_PROMPT_FULL,
        pdfBase64,
        "Analizează complet acest document PDF oficial românesc și explică tot ce trebuie să știe utilizatorul.",
        4096
      );
    } else if (useVision && imageBase64) {
      interpretation = await callClaudeWithImage(
        SYSTEM_PROMPT_FULL,
        imageBase64,
        imageMimeType,
        "Analizează complet această imagine a unui document oficial românesc și explică tot ce trebuie să știe utilizatorul.",
        4096
      );
    } else {
      interpretation = await callClaudeWithText(
        SYSTEM_PROMPT_FULL,
        `Analizează complet acest document oficial și explică tot ce trebuie să știe utilizatorul:\n\n${extractedText}`,
        4096
      );
    }

    res.json({
      interpretation: interpretation,
      type: "full",
      message: "Analiză completă generată cu succes."
    });

  } catch (err) {
    console.error("Error in /api/interpret-full:", err);
    res.status(500).json({ 
      error: "Eroare la procesarea documentului. Încearcă din nou." 
    });
  }
});

/* =======================
   POST /api/claude
   Chat conversațional (după plată)
======================= */
app.post("/api/claude", async (req, res) => {
  console.log("\n=== NEW REQUEST: /api/claude ===");
  
  try {
    const { messages, system, image, documentContext } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Mesajele sunt obligatorii." });
    }

    // Build messages for API
    const formattedMessages = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      
      // Check if last user message has image
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

    // Build system prompt
    let finalSystemPrompt = system || SYSTEM_PROMPT_CHAT;
    
    if (documentContext) {
      finalSystemPrompt += `\n\nCONTEXT DOCUMENT ANALIZAT:\n${documentContext}`;
    }

    // Call Claude
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
   Error Handling Middleware
======================= */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: "Fișierul este prea mare. Maxim 20MB." });
    }
    return res.status(400).json({ error: `Eroare upload: ${err.message}` });
  }
  
  res.status(500).json({ error: "Eroare internă de server." });
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
  console.log(`🚀 Peinteles Backend v2.1 running on port ${PORT}`);
  console.log(`📋 Using Claude AI (Anthropic) + Tesseract OCR`);
  console.log(`📄 Supported: PDF, JPG, PNG, GIF, WEBP, BMP, TIFF, TXT`);
  console.log(`💰 Freemium model: preview + full analysis`);
});
