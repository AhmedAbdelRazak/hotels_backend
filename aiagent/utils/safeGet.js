/** @format */
function sget(obj, path, def = undefined) {
	try {
		return path.split(".").reduce((o, k) => (o ? o[k] : undefined), obj) ?? def;
	} catch (_) {
		return def;
	}
}
module.exports = { sget };
