export function pretty(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("-", " ").replace(/^./, (character) => character.toUpperCase());
}
