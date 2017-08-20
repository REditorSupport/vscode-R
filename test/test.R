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

peopleDf <- data.frame(PersonalID=c("ZP1U3EPU2FKAWI6K5US5LDV50KRI1LN7", "IA26X38HOTOIBHYIRV8CKR5RDS8KNGHV", "LASDU89NRABVJWW779W4JGGAN90IQ5B2"), 
                       FirstName=c("Timmy", "Fela", "Sarah"),
                       LastName=c("Tesa", "Falla", "Kerrigan"),
                       DOB=c("2010-01-01", "1999-1-1", "1992-04-01"))
                       