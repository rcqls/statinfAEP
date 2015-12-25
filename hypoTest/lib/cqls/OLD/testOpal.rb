[1,2,3,4,5].each{|a| p a}
a={a: "toto", b: [1,3,2]}
%x{
console.log(a.map)
}
p a