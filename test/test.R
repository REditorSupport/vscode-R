1:100 -> n -> Ans
Ans[n%%3==0 -> FizzSet] <- "Fizz"
Ans[n%%5==0 -> BuzzSet] <- "Buzz"
Ans[FizzSet & BuzzSet] <- "FizzBuzz"
Ans
print(Ans)