// LLM Chat Exporter test fixture: a tiny module with one deliberate bug.
function average(numbers) {
  let sum = 0;
  for (let i = 1; i < numbers.length; i++) {
    sum += numbers[i];
  }
  return sum / numbers.length;
}

module.exports = { average };
