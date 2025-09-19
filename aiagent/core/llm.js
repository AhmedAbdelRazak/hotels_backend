/** @format */
// aiagent/core/llm.js
const fetch = require("node-fetch");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // pick your default

const hasOpenAI = !!OPENAI_API_KEY;

async function generateWithOpenAI(system, user) {
	// Simple minimal call; replace with your client if you prefer.
	const resp = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${OPENAI_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: OPENAI_MODEL,
			temperature: 0.5,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
		}),
	});
	const data = await resp.json();
	const txt =
		data?.choices?.[0]?.message?.content ||
		"Thanks for your message. How can I help you further?";
	return txt.trim();
}

// Very light templates if no API key is present.
// NOTE: these are intentionally straightforward so you're never silent.
function fallbackTemplateGreet({
	lang,
	firstName,
	agentName,
	hotelName,
	intent,
	extra,
}) {
	const hiEn = `As-salāmu ʿalaykum ${firstName}, I’m ${agentName} from ${hotelName}.`;
	const hiAr = `السلام عليكم ${firstName}، أنا ${agentName} من ${hotelName}.`;
	const hiEs = `As-salamu alaykum ${firstName}, soy ${agentName} de ${hotelName}.`;
	const hiFr = `As-salām ʿalaykum ${firstName}, je suis ${agentName} de ${hotelName}.`;
	const hiUr = `السلام علیکم ${firstName}، میں ${agentName}، ${hotelName} سے۔`;
	const hiHi = `अस्सलामु अलेकुम ${firstName}, मैं ${agentName} ${hotelName} से बोल रहा/रही हूँ।`;

	const bodyEn =
		intent === "update"
			? `I can help you with confirmation ${extra?.cn}. How would you like me to assist with this reservation?`
			: `I see you’d like to make a new reservation. May I confirm your check-in, check-out, number of guests, and room type preference?`;
	const bodyAr =
		intent === "update"
			? `أستطيع مساعدتك بخصوص التأكيد ${extra?.cn}. كيف تود/ين أن أساعدك في هذا الحجز؟`
			: `فهمت أنك ترغب/ين في إنشاء حجز جديد. هل تؤكد/ين تاريخ الوصول والمغادرة وعدد النزلاء ونوع الغرفة؟`;
	const bodyEs =
		intent === "update"
			? `Puedo ayudarte con la confirmación ${extra?.cn}. ¿Cómo te gustaría que te ayude con esta reserva?`
			: `Veo que deseas hacer una nueva reserva. ¿Puedo confirmar tu check‑in, check‑out, número de huéspedes y tipo de habitación?`;
	const bodyFr =
		intent === "update"
			? `Je peux vous aider avec la confirmation ${extra?.cn}. Comment souhaitez-vous que je vous assiste pour cette réservation ?`
			: `Je vois que vous souhaitez effectuer une nouvelle réservation. Puis-je confirmer vos dates d’arrivée et de départ, le nombre de personnes et le type de chambre ?`;
	const bodyUr =
		intent === "update"
			? `میں ${extra?.cn} کنفرمیشن کے ساتھ مدد کر سکتا/سکتی ہوں۔ برائے مہربانی بتائیے کس طرح مدد چاہیئے؟`
			: `آپ نئی بکنگ کرنا چاہتے ہیں۔ کیا میں آپ کی چیک اِن/چیک آؤٹ تاریخیں، مہمانوں کی تعداد اور کمرے کی قسم کی تصدیق کر لوں؟`;
	const bodyHi =
		intent === "update"
			? `मैं ${extra?.cn} कन्फर्मेशन में आपकी मदद कर सकता/सकती हूँ। आप चाहते हैं कि मैं कैसे सहायता करूँ?`
			: `आप नई बुकिंग करना चाहते हैं। क्या मैं आपके चेक‑इन/चेक‑आउट, मेहमानों की संख्या और कमरे की पसंद की पुष्टि कर लूँ?`;

	switch (lang) {
		case "Arabic (Fos7a)":
		case "Arabic (Egyptian)":
			return `${hiAr}\n${bodyAr}`;
		case "Spanish":
			return `${hiEs}\n${bodyEs}`;
		case "French":
			return `${hiFr}\n${bodyFr}`;
		case "Urdu":
			return `${hiUr}\n${bodyUr}`;
		case "Hindi":
			return `${hiHi}\n${bodyHi}`;
		default:
			return `${hiEn}\n${bodyEn}`;
	}
}

async function greetMessage(opts) {
	// opts: { lang, firstName, agentName, hotelName, intent, extra }
	if (hasOpenAI) {
		const sys = `You are a polite Muslim hotel support agent. Always start with an Islamic greeting appropriate for the language. Be concise, warm, and professional.`;
		const user = JSON.stringify(opts);
		try {
			return await generateWithOpenAI(sys, user);
		} catch {
			return fallbackTemplateGreet(opts);
		}
	}
	return fallbackTemplateGreet(opts);
}

async function genericReply(opts) {
	// opts: { lang, context, user, agentName, hotelName }
	if (hasOpenAI) {
		const sys = `You are a Muslim hotel support agent. Keep answers short and courteous. Ask clarifying questions if needed. Language: ${opts.lang}.`;
		const user = `Context:\n${opts.context}\n\nUser said:\n${opts.user}`;
		try {
			return await generateWithOpenAI(sys, user);
		} catch {
			return simpleReply(opts);
		}
	}
	return simpleReply(opts);
}

function simpleReply({ lang }) {
	const en = `Thanks for your message. I’m here to help. Could you please confirm your check-in, check-out, number of guests, and room type?`;
	const ar = `شكرًا لرسالتك. أنا هنا لمساعدتك. هل يمكنك تأكيد تاريخ الوصول والمغادرة وعدد النزلاء ونوع الغرفة؟`;
	const es = `Gracias por tu mensaje. ¿Podrías confirmar check‑in, check‑out, número de huéspedes y tipo de habitación?`;
	const fr = `Merci pour votre message. Pouvez-vous confirmer les dates d’arrivée et de départ, le nombre de personnes et le type de chambre ?`;
	const ur = `شکریہ۔ براہ کرم چیک اِن/چیک آؤٹ، مہمانوں کی تعداد اور کمرے کی قسم بتا دیں۔`;
	const hi = `धन्यवाद। कृपया चेक‑इन/चेक‑आउट, मेहमानों की संख्या और कमरे के प्रकार की पुष्टि करें।`;
	switch (lang) {
		case "Arabic (Fos7a)":
		case "Arabic (Egyptian)":
			return ar;
		case "Spanish":
			return es;
		case "French":
			return fr;
		case "Urdu":
			return ur;
		case "Hindi":
			return hi;
		default:
			return en;
	}
}

module.exports = {
	greetMessage,
	genericReply,
	hasOpenAI,
};
