"use strict";

function digitsToEnglishLocal(value = "") {
	return String(value || "")
		.replace(/[\u0660-\u0669]/g, (digit) =>
			String(digit.charCodeAt(0) - 0x0660)
		)
		.replace(/[\u06f0-\u06f9]/g, (digit) =>
			String(digit.charCodeAt(0) - 0x06f0)
		);
}

function normalizeSignalText(text = "") {
	const raw = digitsToEnglishLocal(String(text || "")).trim();
	const lower = raw.toLowerCase();
	const latin = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
	const latinCompact = latin.replace(/[^a-z0-9]+/g, "");
	const arabic = lower
		.replace(/[\u064b-\u065f\u0670]/g, "")
		.replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
		.replace(/[\u0649\u06cc]/g, "\u064a")
		.replace(/[\u0629\u06c1\u06be\u06d5]/g, "\u0647")
		.replace(/\u06a9/g, "\u0643")
		.replace(/\u06af/g, "\u0643")
		.replace(/\u0686/g, "\u062c")
		.replace(/\s+/g, " ")
		.trim();
	const arabicCompact = arabic.replace(/[^\u0600-\u06ff]+/g, "");
	return { raw, lower, latin, latinCompact, arabic, arabicCompact };
}

function testAny(patterns = [], value = "") {
	return patterns.some((pattern) => pattern.test(value));
}

const SIGNAL_GROUPS = {
	location: {
		lower: [
			/\b(?:where\s+is|where's|located|location|address|area|district|map|directions?|ubicaci[o\u00f3]n|ubicacion|direcci[o\u00f3]n|direccion|adresse|emplacement|localisation|alamat|lokasi|peta|lokasyon|konum|adres)\b/i,
		],
		latinCompact: [
			/(?:whereis|located|location|address|directions|map|ubicacion|direccion|adresse|emplacement|localisation|alamat|lokasi|peta|lokasyon|konum|adres|kahan|kidhar|pata)/i,
		],
		arabic: [
			/(?:\u0627\u064a\u0646|\u0641\u064a\u0646|\u0648\u064a\u0646|\u0645\u0648\u0642\u0639|\u0645\u0643\u0627\u0646|\u0639\u0646\u0648\u0627\u0646|\u062e\u0631\u064a\u0637\u0647|\u0645\u0646\u0637\u0642\u0647|\u062d\u064a|\u06a9\u06c1\u0627\u06ba|\u06a9\u062f\u06be\u0631|\u067e\u062a\u06c1|\u092a\u0924\u093e|\u0915\u0939\u093e\u0902)/i,
		],
		arabicCompact: [/\u0644\u0648\u0643(?:\u064a|\u0627)?\u0634(?:\u064a)?\u0646+/i],
	},
	distance: {
		lower: [
			/\b(?:how\s+far|far\s+from|distance|distancia|lejos|cerca|near|close|walking|walk|a\s+pie|caminando|drive|driving|en\s+voiture|a\s+pied|minutes?|mins?|berapa\s+jauh|jarak|dekat|jalan\s+kaki|menit|minit)\b/i,
		],
		latinCompact: [
			/(?:howfar|farfrom|distance|distancia|nearharam|closeharam|walking|driving|jarak|berapajauh|kitnadoor|kitnidur)/i,
		],
		arabic: [
			/(?:\u0643\u0645\s+\u064a\u0628\u0639\u062f|\u064a\u0628\u0639\u062f|\u0628\u0639\u064a\u062f|\u0642\u0631\u064a\u0628|\u0627\u0644\u0645\u0633\u0627\u0641\u0647|\u0645\u0633\u0627\u0641\u0647|\u062f\u0642\u064a\u0642\u0647|\u062f\u0642\u0627\u064a\u0642|\u0645\u0634\u064a|\u0633\u064a\u0627\u0631\u0647|\u06a9\u062a\u0646\u0627\s+\u062f\u0648\u0631|\u0641\u0627\u0635\u0644\u06c1|\u0645\u0646\u0679)/i,
		],
		arabicCompact: [
			/(?:\u062f\u064a\u0633\u062a\u0646\u0633|\u062f\u0633\u062a\u0646\u0633|\u062f\u064a\u0633\u062a\u0627\u0646\u0633|\u0641\u0627\u0631\u0641\u0631\u0645)/i,
		],
	},
	bus: {
		lower: [/\b(?:bus|buses|shuttle|coach|transport|transportation|transfer)\b/i],
		latinCompact: [
			/(?:bus|buses|shuttle|coach|transport|transportation|transfer|bas|bis|mowaslat|naql|buskeharam|bustoharam)/i,
		],
		arabic: [
			/(?:\u0628\u0627\u0635|\u0628\u0627\u0635\u0627\u062a|\u062d\u0627\u0641\u0644\u0647|\u062d\u0627\u0641\u0644\u0627\u062a|\u0627\u062a\u0648\u0628\u064a\u0633|\u0623\u062a\u0648\u0628\u064a\u0633|\u0634\u0627\u062a\u0644|\u0646\u0642\u0644|\u0645\u0648\u0627\u0635\u0644\u0627\u062a|\u062a\u0631\u0627\u0646\u0633\u0641\u0631|\u0628\u0633\u06cc\u06ba|\u092c\u0938|\u0628\u0627\u0633)/i,
		],
		arabicCompact: [
			/(?:\u0628\u0627\u0635|\u0628\u0627\u0635\u0627\u062a|\u0634\u0627\u062a\u0644|\u0628\u0633|\u0628\u0627\u0633|\u062a\u0631\u0627\u0646\u0633\u0641\u0631|\u062a\u0631\u0627\u0646\u0633\u0628\u0648\u0631\u062a)/i,
		],
	},
	hotel: {
		lower: [/\b(?:hotel|property)\b/i],
		latinCompact: [/(?:hotel|funduq|funduk|fandok|fondo2)/i],
		arabic: [/(?:\u0627\u0644\u0641\u0646\u062f\u0642|\u0641\u0646\u062f\u0642|\u0647\u0648\u062a\u064a\u0644|\u0647\u0648\u062a\u0644)/i],
	},
	reception: {
		lower: [/\b(?:reception|front\s*desk|reservation\s+team|reservations\s+team|staff|manager)\b/i],
		latinCompact: [
			/(?:reception|frontdesk|reservationteam|reservationsteam|staff|manager|resepsionis|recepcion|receptionniste)/i,
		],
		arabic: [
			/(?:\u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u0627\u0644\u062d\u062c\u0648\u0632\u0627\u062a|\u062d\u062c\u0648\u0632\u0627\u062a|\u0645\u0633\u0624\u0648\u0644|\u0645\u0633\u0626\u0648\u0644|\u0645\u062f\u064a\u0631|\u0631\u0633\u0628\u0634\u0646|\u0631\u064a\u0633\u0628\u0634\u0646|\u0631\u0633\u067e\u0634\u0646)/i,
		],
	},
	phone: {
		lower: [/\b(?:phone|telephone|mobile|cell|cellphone|tel)\b/i],
		latinCompact: [/(?:phone|telephone|mobile|cellphone|phonenumber|mobilenumber|telefon|telefono|telephone|telpon|handphone|hp)/i],
		arabic: [
			/(?:\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u062a\u0644\u064a\u0641\u0648\u0646|\u062a\u064a\u0644\u064a\u0641\u0648\u0646|\u0645\u0648\u0628\u0627\u064a\u0644|\u0645\u0648\u0628\u064a\u0644|\u0645\u0648\u0628\u0627\u064a\u0644\u064a|\u0641\u0648\u0646|\u062a\u0644\u0641\u0648\u0646)/i,
		],
	},
	whatsapp: {
		lower: [/\b(?:whatsapp|whats\s*app|watsapp|wattsapp|wasap|wsp)\b/i],
		latinCompact: [/(?:whatsapp|whatsap|watsapp|wattsapp|wasap|wsp)/i],
		arabic: [
			/(?:\u0648\u0627\u062a\u0633|\u0648\u0627\u062a\u0633\u0627\u0628|\u0648\u0627\u062a\u0633\s+\u0627\u0628|\u0648\u062a\u0633\u0627\u0628|\u0648\u062a\u0633\s+\u0627\u0628|\u0627\u0644\u0648\u0627\u062a\u0633|\u0648\u0627\u062a\u0633\u0627\u067e)/i,
		],
		arabicCompact: [
			/(?:\u0648(?:\u0627)?\u062a\u0633(?:\u0627(?:\u0628|\u067e)|\u0628)?|\u0648\u062a\u0633(?:\u0627(?:\u0628|\u067e)|\u0628)?)/i,
		],
	},
	contact: {
		lower: [/\b(?:contact|call|reach|speak\s+to|talk\s+to|connect\s+me)\b/i],
		latinCompact: [/(?:contact|call|reach|speakto|talkto|connectme|hubungi|kontak|contacto|llamar|appeler)/i],
		arabic: [
			/(?:\u0627\u062a\u0635\u0627\u0644|\u0627\u062a\u0635\u0644|\u0627\u062a\u0648\u0627\u0635\u0644|\u0627\u0643\u0644\u0645|\u0627\u0643\u0644\u0645|\u062a\u0648\u0627\u0635\u0644|\u0643\u0644\u0645|\u0627\u0648\u0635\u0644\u0646\u064a)/i,
		],
	},
	email: {
		lower: [/\b(?:email|e-mail|mail|inbox)\b/i],
		latinCompact: [/(?:email|eemail|mail|inbox|correo|courriel|mel|surel|emel)/i],
		arabic: [
			/(?:\u0627\u064a\u0645\u064a\u0644|\u0627\u064a\u0645\u064a\u0644|\u0627\u0644\u0627\u064a\u0645\u064a\u0644|\u0628\u0631\u064a\u062f|\u0645\u064a\u0644)/i,
		],
	},
	link: {
		lower: [/\b(?:link|url|details\s+link|confirmation\s+link|reservation\s+link|enlace|lien|tautan|pautan)\b/i],
		latinCompact: [/(?:link|url|detailslink|confirmationlink|reservationlink|enlace|lien|tautan|pautan)/i],
		arabic: [/(?:\u0631\u0627\u0628\u0637|\u0644\u064a\u0646\u0643|\u0644\u0646\u0643)/i],
	},
	send: {
		lower: [/\b(?:send|resend|share|forward|show|give|provide|email\s+me|text\s+me)\b/i],
		latinCompact: [/(?:send|resend|share|forward|show|give|provide|emailme|textme|enviar|reenviar|envoyer|kirim|hantar)/i],
		arabic: [
			/(?:\u0627\u0631\u0633\u0644|\u0627\u0628\u0639\u062a|\u0627\u0628\u0639\u062b|\u0634\u0627\u0631\u0643|\u0648\u062c\u0647|\u0648\u0631\u064a\u0646\u064a|\u0627\u062f\u064a\u0646\u064a|\u0627\u0639\u0637\u064a\u0646\u064a|\u0623\u0639\u0637\u064a\u0646\u064a)/i,
		],
	},
	confirmation: {
		lower: [/\b(?:confirmation|confirm|confirmed|reference|ref|voucher|receipt|invoice)\b/i],
		latinCompact: [
			/(?:confirmation|confirm|confirmed|reference|refnumber|voucher|receipt|invoice|confirmacion|confirmacion|confirmar|confirmacao|confirmationde|confirmationdu|pengesahan|pengesahan|tasdiq|taakeed|taked|ta2keed|takid|konfirmasi|konfirmation|konfirmasi|konfirmasi)/i,
		],
		arabic: [
			/(?:\u062a\u0627\u0643\u064a\u062f|\u062a\u0623\u0643\u064a\u062f|\u0627\u0644\u062a\u0627\u0643\u064a\u062f|\u0627\u0644\u062a\u0623\u0643\u064a\u062f|\u0645\u0631\u062c\u0639|\u0627\u064a\u0635\u0627\u0644|\u0641\u0627\u062a\u0648\u0631\u0647|\u062a\u0635\u062f\u064a\u0642|\u062a\u0627\u0626\u064a\u062f)/i,
		],
		arabicCompact: [
			/(?:\u0643(?:\u0648)?\u0646\u0641(?:\u064a|\u0648)?\u0631?\u0645(?:\u064a\u0634\u0646)?|\u0643(?:\u0648)?\u0646\u0641\u0631\u0645\u064a\u0634\u0646|\u0631\u064a\u0641\u0631\u0646\u0633|\u0641\u0648\u062a\u0634\u0631|\u0641\u0627\u0648\u062a\u0634\u0631)/i,
		],
	},
	reservation: {
		lower: [
			/\b(?:reservation|reserve|booking|booked|book|reserva|reservaci[o\u00f3]n|reservacion|r[e\u00e9]servation|reserver|reserver|habitacion|chambre|reservasi|tempahan|pesan\s+kamar|tempah\s+bilik)\b/i,
		],
		latinCompact: [
			/(?:reservation|reserve|booking|booked|bookroom|reserva|reservacion|reservation|reserver|reservasi|tempahan|pesankamar|tempahbilik|buking|boking|hajz|hegiz|hijz)/i,
		],
		arabic: [
			/(?:\u062d\u062c\u0632|\u0627\u0644\u062d\u062c\u0632|\u0627\u062d\u062c\u0632|\u0623\u062d\u062c\u0632|\u0645\u062d\u062c\u0648\u0632|\u062d\u062c\u0648\u0632\u0627\u062a|\u0628\u0643\u0646\u06af)/i,
		],
		arabicCompact: [
			/(?:\u0628\u0648\u0643(?:\u064a)?\u0646(?:\u062c|\u0642|\u0643|\u06af)|\u0628\u0643\u0646\u06af|\u0631\u064a\u0632(?:\u0631|\u064a\u0631)?\u0641\u064a\u0634\u0646|\u0631\u064a\u0633\u0631\u0641\u064a\u0634\u0646)/i,
		],
	},
	newBooking: {
		lower: [
			/\b(?:book|reserve|make\s+(?:a\s+)?reservation|new\s+(?:booking|reservation)|book\s+a\s*room|reserve\s+a\s*room|need\s+a\s*room|want\s+a\s*room|reservar|r[e\u00e9]server|pesan\s+kamar|tempah\s+bilik)\b/i,
		],
		latinCompact: [
			/(?:book|reserve|makeareservation|newbooking|newreservation|bookaroom|reservearoom|needaroom|wantaroom|reservar|reserver|pesankamar|tempahbilik)/i,
		],
		arabic: [
			/(?:\u0627\u062d\u062c\u0632|\u0623\u062d\u062c\u0632|\u062d\u062c\u0632\s+\u063a\u0631\u0641|\u0627\u0628\u063a\u0649\s+\u063a\u0631\u0641|\u0623\u0628\u063a\u0649\s+\u063a\u0631\u0641|\u0627\u0631\u064a\u062f\s+\u063a\u0631\u0641|\u0623\u0631\u064a\u062f\s+\u063a\u0631\u0641)/i,
		],
	},
	room: {
		lower: [/\b(?:room|rooms|bed|beds|suite|suites|guest|guests|adult|adults|pax)\b/i],
		latinCompact: [/(?:room|rooms|bed|beds|suite|suites|guest|guests|adult|adults|pax|kamar|bilik|habitacion|chambre|ghorfa|ghurfa)/i],
		arabic: [
			/(?:\u063a\u0631\u0641\u0647|\u063a\u0631\u0641|\u0627\u0648\u0636\u0647|\u0633\u0631\u064a\u0631|\u0627\u0633\u0631\u0647|\u0628\u0627\u0644\u063a|\u0634\u062e\u0635|\u0627\u0634\u062e\u0627\u0635)/i,
		],
	},
	payment: {
		lower: [/\b(?:payment|pay|paid|card|declined|failed|invoice|pago|pagar|paiement|payer|pembayaran|bayar|bayaran|kad)\b/i],
		latinCompact: [
			/(?:payment|pay|paid|card|declined|failed|invoice|pago|pagar|paiement|payer|pembayaran|bayar|bayaran|kad|adaigi)/i,
		],
		arabic: [
			/(?:\u062f\u0641\u0639|\u0627\u0644\u062f\u0641\u0639|\u0628\u0637\u0627\u0642\u0647|\u0643\u0631\u062a|\u0643\u0627\u0631\u062f|\u0641\u0627\u062a\u0648\u0631\u0647|\u0645\u0631\u0641\u0648\u0636|\u0641\u0634\u0644|\u0627\u062f\u0627\u0626\u06cc\u06af\u06cc)/i,
		],
		arabicCompact: [
			/(?:\u0628\u0627\u064a\u0645\u0646\u062a|\u0628\u064a\u0645\u0646\u062a|\u0628\u0627\u064a\u064a\u0645\u0646\u062a|\u0628\u064a\u0645\u0646\u062a|\u0643\u0631\u064a\u062f\u062a\u0643\u0627\u0631\u062f|\u0643\u0627\u0631\u062f)/i,
		],
	},
	direct: {
		lower: [/\b(?:direct|directly|official|officially|authorized|authorised|connected\s+to)\b/i],
		latinCompact: [
			/(?:direct|directly|official|officially|authorized|authorised|connectedto|directamente|oficial|autorizado|autorisee|autorise|langsung|terus|rasmi)/i,
		],
		arabic: [
			/(?:\u0645\u0628\u0627\u0634\u0631|\u0645\u0628\u0627\u0634\u0631\u0647|\u0631\u0633\u0645\u064a|\u0631\u0633\u0645\u064a\u0627|\u0645\u062a\u0648\u0627\u0635\u0644|\u0645\u0639\u062a\u0645\u062f|\u062f\u0627\u064a\u0631\u0643\u062a|\u062f\u064a\u0631\u0643\u062a|\u0627\u0648\u0641\u0634\u0627\u0644|\u0627\u0648\u0641\u064a\u0634\u0627\u0644)/i,
		],
	},
	workWith: {
		lower: [/\b(?:working\s+with|work\s+with|deal\s+with|partnered\s+with|coordinate\s+with|represent)\b/i],
		latinCompact: [
			/(?:workingwith|workwith|dealwith|partneredwith|coordinatewith|represent|trabaja|trabajan|trabajas|trabajando|travaille|travaillez|bekerja|kerjasama|berurusan)/i,
		],
		arabic: [
			/(?:\u062a\u062a\u0639\u0627\u0645\u0644|\u062a\u0639\u0645\u0644|\u062a\u0634\u062a\u063a\u0644|\u0634\u063a\u0627\u0644|\u0634\u063a\u0627\u0644\u064a\u0646|\u0645\u062a\u0639\u0627\u0645\u0644|\u0645\u062a\u0648\u0627\u0635\u0644|\u062a\u0645\u062b\u0644)/i,
		],
	},
};

function semanticSignals(text = "") {
	const normalized = normalizeSignalText(text);
	const signals = new Set();
	for (const [name, group] of Object.entries(SIGNAL_GROUPS)) {
		if (
			testAny(group.lower, normalized.lower) ||
			testAny(group.latin, normalized.latin) ||
			testAny(group.latinCompact, normalized.latinCompact) ||
			testAny(group.arabic, normalized.arabic) ||
			testAny(group.arabicCompact, normalized.arabicCompact)
		) {
			signals.add(name);
		}
	}
	return signals;
}

function normalizeCategories(categories) {
	return Array.isArray(categories) ? categories : [categories];
}

function hasSemanticSignal(text = "", categories = []) {
	const signals = semanticSignals(text);
	return normalizeCategories(categories).some((category) => signals.has(category));
}

function hasAllSemanticSignals(text = "", categories = []) {
	const signals = semanticSignals(text);
	return normalizeCategories(categories).every((category) => signals.has(category));
}

module.exports = {
	normalizeSignalText,
	semanticSignals,
	hasSemanticSignal,
	hasAllSemanticSignals,
};
