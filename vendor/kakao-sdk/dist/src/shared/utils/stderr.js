const isTTY = process.stderr.isTTY ?? false;
const RESET = isTTY ? '\x1b[0m' : '';
const RED = isTTY ? '\x1b[31m' : '';
const YELLOW = isTTY ? '\x1b[33m' : '';
const DIM = isTTY ? '\x1b[2m' : '';
export function info(message) {
    process.stderr.write(`${message}\n`);
}
export function warn(message) {
    process.stderr.write(`${YELLOW}${message}${RESET}\n`);
}
export function error(message) {
    process.stderr.write(`${RED}${message}${RESET}\n`);
}
export function debug(message) {
    process.stderr.write(`${DIM}${message}${RESET}\n`);
}
//# sourceMappingURL=stderr.js.map