export type Result<T, E> = Readonly<{ tag: "ok"; value: T }> | Readonly<{ tag: "err"; error: E }>;

export type Option<T> = Readonly<{ tag: "some"; value: T }> | Readonly<{ tag: "none" }>;

export function ok<T>(value: T): Result<T, never> {
  return Object.freeze({ tag: "ok", value });
}

export function err<E>(error: E): Result<never, E> {
  return Object.freeze({ tag: "err", error });
}

export function some<T>(value: T): Option<T> {
  return Object.freeze({ tag: "some", value });
}

export const none: Option<never> = Object.freeze({ tag: "none" });

export function map<T, U, E>(result: Result<T, E>, transform: (value: T) => U): Result<U, E> {
  return result.tag === "ok" ? ok(transform(result.value)) : result;
}

export function andThen<T, U, E, F>(
  result: Result<T, E>,
  transform: (value: T) => Result<U, F>,
): Result<U, E | F> {
  return result.tag === "ok" ? transform(result.value) : result;
}

export function mapOption<T, U>(option: Option<T>, transform: (value: T) => U): Option<U> {
  return option.tag === "some" ? some(transform(option.value)) : none;
}

export function andThenOption<T, U>(
  option: Option<T>,
  transform: (value: T) => Option<U>,
): Option<U> {
  return option.tag === "some" ? transform(option.value) : none;
}

export function sequence<T, E>(results: ReadonlyArray<Result<T, E>>): Result<readonly T[], E> {
  const failure = results.find((result) => result.tag === "err");
  return (
    failure ??
    ok(Object.freeze(results.flatMap((result) => (result.tag === "ok" ? [result.value] : []))))
  );
}
