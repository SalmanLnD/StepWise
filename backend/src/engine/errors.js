export class StepwiseError extends Error {
  constructor(message, line = null, kind = 'RuntimeError') {
    super(message);
    this.line = line;
    this.kind = kind;
  }
}

export class ParseError extends StepwiseError {
  constructor(message, line = null) {
    super(message, line, 'SyntaxError');
  }
}

export class LimitError extends StepwiseError {
  constructor(message, line = null) {
    super(message, line, 'LimitExceeded');
  }
}

/* Control-flow signals (not user-visible errors) */
export const BREAK = Symbol('break');
export const CONTINUE = Symbol('continue');

export class ReturnSignal {
  constructor(value) {
    this.value = value;
  }
}
