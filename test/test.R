# © Microsoft. All rights reserved.

#' Add together two numbers.
#'
#' @param x A number.
#' @param y A number.
#' @return The sum of \code{x} and \code{y}.
#' @examples
#' add(1, 1)
#' add(10, 1)
add <- function(x, y) {
  x + y
}

print(add(1, -2))
print(add(1.0e10, 2.0e10))

print(paste("one", NULL))
print(paste(NA, 'two'))

print(paste("multi-
line",
'multi-
line'))