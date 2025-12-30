const input = "move part2 bottom to part1 top";
const match = input.match(/move\s+(.+?)(?:\s+(top|bottom|left|right|front|back|center))?\s+to\s+(.+?)(?:\s+(top|bottom|left|right|front|back|center))?$/i);

if (match) {
    console.log("Source:", match[1].trim());
    console.log("Source Face:", match[2]);
    console.log("Target:", match[3].trim());
    console.log("Target Face:", match[4]);
} else {
    console.log("No match");
}
