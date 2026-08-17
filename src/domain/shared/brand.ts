/** Phantom brand used to distinguish otherwise-identical string types at compile time. */
export type Brand<T, B extends string> = T & { readonly __brand: B };
