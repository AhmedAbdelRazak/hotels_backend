/** @format */
function format(tpl, vars = {}) {
	return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

/* ================= ENGLISH ================= */
const en = {
	code: "en",
	t: (k, v = {}) =>
		format(
			{
				salam_reply: "Wa alaikum assalam! 😊",
				how_are_you_reply: "I'm great, thanks! Shall we continue your booking?",
				welcome_reply: "You're most welcome! 🙏",
				greet_new_reservation:
					"Assalamu alaikum {{name}}! I see you’d like a new reservation at {{hotel}}.",
				greet_update_reservation:
					"Assalamu alaikum {{name}}! I see you’d like to update reservation **{{cn}}** at {{hotel}}.",
				greet_update_reservation_missing:
					"Assalamu alaikum {{name}}! I see you’d like a reservation update at {{hotel}}. Please share the confirmation number.",
				update_intro:
					"No problem. You can change dates, room type, or guest details.",
				ask_checkin: "What’s your check‑in date? (YYYY‑MM‑DD)",
				ask_checkout: "And your check‑out date? (YYYY‑MM‑DD)",
				ask_room_type: "Which room type would you like?\n{{options}}",
				ask_full_name: "May I have your full name as on your passport?",
				ask_name_confirm: "Is your name **{{name}}** as written in this chat?",
				ask_phone: "Please share a phone number we can reach you on.",
				ask_nationality: "What’s your nationality (e.g., EG, SA, DZ)?",
				ask_email: "Please share your email to send the confirmation.",
				room_blocked:
					"That room seems unavailable because one of the dates is blocked ({{date}}). Would you like another room type or different dates?",
				quote_summary:
					"Great! For **{{hotel}}**, **{{room}}** — **{{dates}}** ({{nights}} nights):\nPer night ~ **{{perNight}} {{currency}}**. Total ~ **{{total}} {{currency}}**.",
				confirm_all:
					"Please review:\n• Dates: {{dates}}\n• Room: {{room}}\n• Name: {{name}}\n• Phone: {{phone}}\n• Nationality: {{nationality}}\n• Email: {{email}}\n\nShall I proceed to finalize the reservation?",
				reservation_created:
					"Alhamdulillah, your reservation is confirmed. Confirmation number: **{{cn}}**. Reception has been notified.",
				reservation_updated:
					"Update completed. Your confirmation number remains: **{{cn}}**. Reception has been notified.",
				reservation_error:
					"Sorry, we couldn’t complete this right now. Please try again or let us know.",
				no_problem: "No problem — tell me what you’d like to adjust.",
				faq_distance_haram:
					"We’re close to Al‑Haram: walking ~ {{walking}}, driving ~ {{driving}} (traffic permitting).",
				faq_wifi:
					"{{hasWifi ? 'Wi‑Fi is available in rooms.' : 'Wi‑Fi info is limited; please ask reception for exact coverage.'}}",
				faq_kitchen:
					"{{hasKitchen ? 'Guest kitchens are available.' : 'Kitchen access is not listed; please ask reception.'}}",
				faq_parking:
					"{{available ? 'Parking is available (subject to availability).' : 'Parking is not listed; please ask reception.'}}",
				generic_answer: "Certainly! I’m happy to help.",
			}[k] || k,
			v
		),
};

/* ================= ARABIC (Blend) ================= */
const arBlend = {
	code: "ar-blend",
	t: (k, v = {}) =>
		format(
			{
				salam_reply: "وعليكم السلام ورحمة الله 🤍",
				how_are_you_reply: "بخير الحمد لله! نكمل الحجز؟",
				welcome_reply: "العفو 🌷",
				greet_new_reservation:
					"السلام عليكم {{name}}! واضح إنك عايز حجز جديد في {{hotel}}.",
				greet_update_reservation:
					"السلام عليكم {{name}}! واضح إنك عايز تعدِّل الحجز رقم **{{cn}}** في {{hotel}}.",
				greet_update_reservation_missing:
					"السلام عليكم {{name}}! واضح إنك عايز تعدِّل حجزك في {{hotel}}. من فضلك رقم التأكيد.",
				update_intro: "تقدر تغيّر التواريخ، نوع الغرفة، أو بيانات الضيف.",
				ask_checkin: "ما هو تاريخ الوصول؟ (YYYY‑MM‑DD)",
				ask_checkout: "وما هو تاريخ المغادرة؟ (YYYY‑MM‑DD)",
				ask_room_type: "تحب نوع غرفة إيه؟\n{{options}}",
				ask_full_name: "اسمك الكامل كما في جواز السفر؟",
				ask_name_confirm: "هل اسمك **{{name}}** كما يظهر في المحادثة؟",
				ask_phone: "رقم الجوال للتواصل لو سمحت.",
				ask_nationality: "الجنسية؟ (مثال: EG، SA، DZ)",
				ask_email: "البريد الإلكتروني لإرسال التأكيد.",
				room_blocked:
					"الغرفة غير متاحة لتاريخ في المنتصف ({{date}}). تحب تغيير النوع أو التواريخ؟",
				quote_summary:
					"تمام! في **{{hotel}}**، **{{room}}** — **{{dates}}** ({{nights}} ليلة):\nمتوسط الليلة ~ **{{perNight}} {{currency}}**. الإجمالي ~ **{{total}} {{currency}}**.",
				confirm_all:
					"راجِع فضلًا:\n• التواريخ: {{dates}}\n• الغرفة: {{room}}\n• الاسم: {{name}}\n• الجوال: {{phone}}\n• الجنسية: {{nationality}}\n• البريد: {{email}}\n\nأكمل الحجز؟",
				reservation_created:
					"تم بحمد الله. رقم التأكيد: **{{cn}}**. تم إبلاغ الاستقبال.",
				reservation_updated:
					"تم التعديل. رقم التأكيد: **{{cn}}**. تم إبلاغ الاستقبال.",
				reservation_error: "عذرًا، لم يكتمل الآن. حاول مرة أخرى أو أخبرنا.",
				no_problem: "تمام — قل لي تحب تغيّر إيه.",
				faq_distance_haram:
					"نحن قريبون من الحرم: مشيًا ~ {{walking}}، وبالسيارة ~ {{driving}} (حسب الزحام).",
				faq_wifi:
					"{{hasWifi ? 'الواي‑فاي متوفر في الغرف.' : 'معلومة الإنترنت غير مؤكدة — يُرجى سؤال الاستقبال.'}}",
				faq_kitchen:
					"{{hasKitchen ? 'المطابخ متاحة للنزلاء.' : 'وضع المطابخ غير مذكور — يُرجى سؤال الاستقبال.'}}",
				faq_parking:
					"{{available ? 'مواقف متاحة (حسب التوفر).' : 'المواقف غير مذكورة — يُرجى سؤال الاستقبال.'}}",
				generic_answer: "تمام، حاضر.",
			}[k] || k,
			v
		),
};

/* ================= ARABIC (Egyptian) ================= */
const arEg = { ...arBlend, code: "ar-eg" };

/* ================= ARABIC (Saudi/Gulf) ================= */
const arSa = {
	code: "ar-sa",
	t: (k, v = {}) =>
		format(
			{
				...arBlend.t("", {}), // dummy to allow spread-like text reuse
				salam_reply: "وعليكم السلام ورحمة الله وبركاته 🌟",
				greet_new_reservation:
					"السلام عليكم {{name}}! يظهر إنك ترغب بحجز جديد في {{hotel}}.",
				greet_update_reservation:
					"السلام عليكم {{name}}! تود تعديل الحجز رقم **{{cn}}** في {{hotel}}.",
				greet_update_reservation_missing:
					"السلام عليكم {{name}}! ترغب بتعديل الحجوزات في {{hotel}}. تفضل رقم التأكيد.",
				update_intro:
					"بخدمتكم — ممكن نغيّر التواريخ أو نوع الغرفة أو بيانات الضيف.",
				generic_answer: "بخدمتك.",
			}[k] || k,
			v
		),
};

/* ================= SPANISH ================= */
const es = {
	code: "es",
	t: (k, v = {}) =>
		format(
			{
				salam_reply: "¡Wa alaikum assalam! 😊",
				how_are_you_reply: "¡Estoy muy bien! ¿Seguimos con tu reserva?",
				welcome_reply: "¡De nada! 🙏",
				greet_new_reservation:
					"¡Assalamu alaikum {{name}}! Veo que deseas una nueva reserva en {{hotel}}.",
				greet_update_reservation:
					"¡Assalamu alaikum {{name}}! Veo que deseas actualizar la reserva **{{cn}}** en {{hotel}}.",
				greet_update_reservation_missing:
					"¡Assalamu alaikum {{name}}! Para actualizar la reserva en {{hotel}}, comparte el número de confirmación.",
				update_intro:
					"Puedes cambiar fechas, tipo de habitación o datos del huésped.",
				ask_checkin: "¿Fecha de check‑in? (YYYY‑MM‑DD)",
				ask_checkout: "¿Fecha de check‑out? (YYYY‑MM‑DD)",
				ask_room_type: "¿Qué tipo de habitación prefieres?\n{{options}}",
				ask_full_name: "¿Tu nombre completo tal como aparece en el pasaporte?",
				ask_name_confirm: "¿Tu nombre es **{{name}}** como aparece en el chat?",
				ask_phone: "Comparte un número de teléfono para contactarte.",
				ask_nationality: "¿Nacionalidad? (ej., EG, SA, DZ)",
				ask_email: "Tu correo electrónico para enviar la confirmación.",
				room_blocked:
					"Esa habitación no está disponible porque una fecha intermedia está bloqueada ({{date}}). ¿Cambiar de tipo o de fechas?",
				quote_summary:
					"Perfecto. En **{{hotel}}**, **{{room}}** — **{{dates}}** ({{nights}} noches):\nPor noche ~ **{{perNight}} {{currency}}**. Total ~ **{{total}} {{currency}}**.",
				confirm_all:
					"Revisa por favor:\n• Fechas: {{dates}}\n• Habitación: {{room}}\n• Nombre: {{name}}\n• Teléfono: {{phone}}\n• Nacionalidad: {{nationality}}\n• Email: {{email}}\n\n¿Confirmo la reserva?",
				reservation_created:
					"Listo. Tu reserva está confirmada. Nº de confirmación: **{{cn}}**. Recepción informada.",
				reservation_updated:
					"Actualización completada. Nº de confirmación: **{{cn}}**. Recepción informada.",
				reservation_error:
					"No pudimos completar esto ahora. Por favor, inténtalo de nuevo.",
				no_problem: "Sin problema, dime qué quieres ajustar.",
				faq_distance_haram:
					"Estamos cerca de Al‑Haram: andando ~ {{walking}}, en coche ~ {{driving}} (según tráfico).",
				faq_wifi:
					"{{hasWifi ? 'Hay Wi‑Fi en las habitaciones.' : 'No tenemos detalles del Wi‑Fi; pregunta en recepción.'}}",
				faq_kitchen:
					"{{hasKitchen ? 'Hay cocinas disponibles.' : 'No aparece cocina; consulta en recepción.'}}",
				faq_parking:
					"{{available ? 'Hay estacionamiento (según disponibilidad).' : 'No figura estacionamiento; consulta en recepción.'}}",
				generic_answer: "¡Con gusto!",
			}[k] || k,
			v
		),
};

/* ================= FRENCH ================= */
const fr = {
	code: "fr",
	t: (k, v = {}) =>
		format(
			{
				salam_reply: "Wa alaikum assalam ! 😊",
				how_are_you_reply:
					"Je vais très bien, merci ! On continue la réservation ?",
				welcome_reply: "Avec plaisir ! 🙏",
				greet_new_reservation:
					"Assalamu alaikum {{name}} ! Je vois que vous souhaitez une nouvelle réservation à {{hotel}}.",
				greet_update_reservation:
					"Assalamu alaikum {{name}} ! Vous souhaitez modifier la réservation **{{cn}}** à {{hotel}}.",
				greet_update_reservation_missing:
					"Assalamu alaikum {{name}} ! Pour modifier la réservation, veuillez partager le numéro de confirmation.",
				update_intro:
					"Vous pouvez changer les dates, le type de chambre ou les informations du client.",
				ask_checkin: "Date d’arrivée ? (YYYY‑MM‑DD)",
				ask_checkout: "Date de départ ? (YYYY‑MM‑DD)",
				ask_room_type: "Quel type de chambre souhaitez‑vous ?\n{{options}}",
				ask_full_name: "Votre nom complet tel qu’au passeport ?",
				ask_name_confirm:
					"Votre nom est‑il **{{name}}** comme indiqué dans le chat ?",
				ask_phone: "Un numéro de téléphone pour vous joindre.",
				ask_nationality: "Votre nationalité ? (ex. EG, SA, DZ)",
				ask_email: "Votre e‑mail pour l’envoi de la confirmation.",
				room_blocked:
					"Cette chambre n’est pas disponible car une date intermédiaire est bloquée ({{date}}). Changer de type ou de dates ?",
				quote_summary:
					"Parfait. À **{{hotel}}**, **{{room}}** — **{{dates}}** ({{nights}} nuits) :\nPar nuit ~ **{{perNight}} {{currency}}**. Total ~ **{{total}} {{currency}}**.",
				confirm_all:
					"Veuillez vérifier :\n• Dates : {{dates}}\n• Chambre : {{room}}\n• Nom : {{name}}\n• Téléphone : {{phone}}\n• Nationalité : {{nationality}}\n• E‑mail : {{email}}\n\nPuis‑je finaliser la réservation ?",
				reservation_created:
					"Votre réservation est confirmée. N° de confirmation : **{{cn}}**. Réception informée.",
				reservation_updated:
					"Mise à jour effectuée. N° de confirmation : **{{cn}}**. Réception informée.",
				reservation_error: "Désolé, impossible de finaliser pour l’instant.",
				no_problem: "Pas de souci — dites‑moi ce que vous souhaitez modifier.",
				faq_distance_haram:
					"Nous sommes proches d’Al‑Haram : à pied ~ {{walking}}, en voiture ~ {{driving}} (selon trafic).",
				faq_wifi:
					"{{hasWifi ? 'Wi‑Fi disponible dans les chambres.' : 'Infos Wi‑Fi limitées — merci de voir avec la réception.'}}",
				faq_kitchen:
					"{{hasKitchen ? 'Des cuisines sont disponibles.' : 'Accès cuisine non indiqué — voir réception.'}}",
				faq_parking:
					"{{available ? 'Parking disponible (selon disponibilités).' : 'Parking non indiqué — voir réception.'}}",
				generic_answer: "Avec plaisir.",
			}[k] || k,
			v
		),
};

/* ================= URDU ================= */
const ur = {
	code: "ur",
	t: (k, v = {}) =>
		format(
			{
				salam_reply: "وعلیکم السلام! 😊",
				how_are_you_reply: "الحمد للہ، خیریت سے ہوں! کیا ہم بکنگ جاری رکھیں؟",
				welcome_reply: "شکریہ! 🙏",
				greet_new_reservation:
					"السلام علیکم {{name}}! لگتا ہے آپ {{hotel}} میں نئی بکنگ کرنا چاہتے ہیں۔",
				greet_update_reservation:
					"السلام علیکم {{name}}! آپ بکنگ **{{cn}}** میں تبدیلی کرنا چاہتے ہیں ({{hotel}})۔",
				greet_update_reservation_missing:
					"السلام علیکم {{name}}! براہ کرم کنفرمیشن نمبر شیئر کریں تاکہ تبدیلی کی جائے۔",
				update_intro:
					"آپ تاریخیں، کمرے کی قسم یا مہمان کی معلومات تبدیل کر سکتے ہیں۔",
				ask_checkin: "چیک اِن کی تاریخ؟ (YYYY‑MM‑DD)",
				ask_checkout: "چیک آؤٹ کی تاریخ؟ (YYYY‑MM‑DD)",
				ask_room_type: "کون سی کمرہ قسم پسند کریں گے؟\n{{options}}",
				ask_full_name: "براہ کرم پاسپورٹ کے مطابق پورا نام بتائیں۔",
				ask_name_confirm:
					"کیا آپ کا نام **{{name}}** ہے جیسا کہ چیٹ میں نظر آ رہا ہے؟",
				ask_phone: "رابطہ کے لیے فون نمبر۔",
				ask_nationality: "قومیت؟ (مثلاً EG, SA, DZ)",
				ask_email: "کنفرمیشن بھیجنے کے لیے ای میل۔",
				room_blocked:
					"یہ کمرہ دستیاب نہیں کیونکہ درمیان کی ایک تاریخ بلاک ہے ({{date}})۔ کیا آپ قسم یا تاریخیں بدلنا چاہیں گے؟",
				quote_summary:
					"بہترین! **{{hotel}}**، **{{room}}** — **{{dates}}** ({{nights}} راتیں):\nفی رات ~ **{{perNight}} {{currency}}**. کل ~ **{{total}} {{currency}}**.",
				confirm_all:
					"برائے کرم تصدیق کریں:\n• تاریخیں: {{dates}}\n• کمرہ: {{room}}\n• نام: {{name}}\n• فون: {{phone}}\n• قومیت: {{nationality}}\n• ای میل: {{email}}\n\nکیا میں بکنگ فائنل کر دوں؟",
				reservation_created:
					"الحمد للہ، آپ کی بکنگ کنفرم ہے۔ کنفرمیشن نمبر: **{{cn}}**۔ ریسپشن کو مطلع کر دیا گیا ہے۔",
				reservation_updated:
					"اپڈیٹ مکمل۔ کنفرمیشن نمبر: **{{cn}}**۔ ریسپشن کو مطلع کر دیا گیا ہے۔",
				reservation_error: "معذرت، ابھی مکمل نہیں ہو سکا۔ دوبارہ کوشش کریں۔",
				no_problem: "کوئی مسئلہ نہیں — بتائیں کیا تبدیل کرنا ہے۔",
				faq_distance_haram:
					"ہم الحرم کے قریب ہیں: پیدل ~ {{walking}}، گاڑی سے ~ {{driving}} (ٹریفک کے مطابق)۔",
				faq_wifi:
					"{{hasWifi ? 'کمرون میں وائی فائی موجود ہے۔' : 'وائی فائی کی معلومات دستیاب نہیں — براہ کرم ریسپشن سے پوچھیں۔'}}",
				faq_kitchen:
					"{{hasKitchen ? 'مہمانوں کے لیے کچن دستیاب ہے۔' : 'کچن کا ذکر نہیں — ریسپشن سے معلومات لیں۔'}}",
				faq_parking:
					"{{available ? 'پارکنگ دستیاب (دستیابی کے مطابق)۔' : 'پارکنگ کا ذکر نہیں — براہ کرم ریسپشن سے پوچھیں۔'}}",
				generic_answer: "ضرور!",
			}[k] || k,
			v
		),
};

/* ================= HINDI ================= */
const hi = {
	code: "hi",
	t: (k, v = {}) =>
		format(
			{
				salam_reply: "वा अलेकुम अस्सलाम! 😊",
				how_are_you_reply: "मैं ठीक हूँ! क्या हम बुकिंग आगे बढ़ाएँ?",
				welcome_reply: "धन्यवाद! 🙏",
				greet_new_reservation:
					"अस्सलामु अलैकुम {{name}}! आप {{hotel}} में नई बुकिंग करना चाहते हैं।",
				greet_update_reservation:
					"अस्सलामु अलैकुम {{name}}! आप बुकिंग **{{cn}}** अपडेट करना चाहते हैं ({{hotel}}).",
				greet_update_reservation_missing:
					"अस्सलामु अलैकुम {{name}}! कृपया कन्फर्मेशन नंबर साझा करें।",
				update_intro: "आप डेट्स, रूम टाइप या गेस्ट डिटेल्स बदल सकते हैं।",
				ask_checkin: "चेक‑इन तारीख? (YYYY‑MM‑DD)",
				ask_checkout: "चेक‑आउट तारीख? (YYYY‑MM‑DD)",
				ask_room_type: "कौन‑सा रूम टाइप चाहिए?\n{{options}}",
				ask_full_name: "पासपोर्ट के अनुसार पूरा नाम बताएँ।",
				ask_name_confirm: "क्या आपका नाम **{{name}}** है, जैसा चैट में है?",
				ask_phone: "कॉन्टैक्ट के लिए फ़ोन नंबर।",
				ask_nationality: "राष्ट्रीयता? (जैसे EG, SA, DZ)",
				ask_email: "कन्फर्मेशन भेजने के लिए ई‑मेल।",
				room_blocked:
					"यह कमरा उपलब्ध नहीं है क्योंकि बीच की एक तारीख ब्लॉक है ({{date}})। क्या हम टाइप या डेट्स बदलें?",
				quote_summary:
					"ठीक है! **{{hotel}}**, **{{room}}** — **{{dates}}** ({{nights}} रात):\nप्रति रात ~ **{{perNight}} {{currency}}**. कुल ~ **{{total}} {{currency}}**.",
				confirm_all:
					"कृपया जाँचें:\n• तारीखें: {{dates}}\n• कमरा: {{room}}\n• नाम: {{name}}\n• फ़ोन: {{phone}}\n• राष्ट्रीयता: {{nationality}}\n• ई‑मेल: {{email}}\n\nक्या मैं बुकिंग फाइनल कर दूँ?",
				reservation_created:
					"बुकिंग कन्फर्म है। कन्फर्मेशन नंबर: **{{cn}}**. रिसेप्शन को सूचित कर दिया गया है।",
				reservation_updated:
					"अपडेट पूरा। कन्फर्मेशन नंबर: **{{cn}}**. रिसेप्शन को सूचित कर दिया गया है।",
				reservation_error: "क्षमा करें, अभी पूरा नहीं हो पाया।",
				no_problem: "कोई बात नहीं — बताएँ क्या बदलना है।",
				faq_distance_haram:
					"हम हरम के पास हैं: पैदल ~ {{walking}}, कार से ~ {{driving}} (ट्रैफ़िक के अनुसार)।",
				faq_wifi:
					"{{hasWifi ? 'कमरों में वाई‑फाई उपलब्ध है।' : 'वाई‑फाई जानकारी उपलब्ध नहीं — रिसेप्शन से पूछें।'}}",
				faq_kitchen:
					"{{hasKitchen ? 'मेहमानों के लिए किचन उपलब्ध।' : 'किचन का उल्लेख नहीं — रिसेप्शन से पूछें।'}}",
				faq_parking:
					"{{available ? 'पार्किंग उपलब्ध (उपलब्धता के अनुसार)।' : 'पार्किंग का उल्लेख नहीं — रिसेप्शन से पूछें।'}}",
				generic_answer: "ज़रूर!",
			}[k] || k,
			v
		),
};

module.exports = {
	en,
	"ar-blend": arBlend,
	"ar-eg": arEg,
	"ar-sa": arSa,
	es,
	fr,
	ur,
	hi,
};
