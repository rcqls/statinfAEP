require 'opal'
require 'opal-parser'

class Distribution

		attr_accessor :list, :name, :params, :distrib

		def initialize(name=nil,params=[])
			unless @@list
				@@list={
					unif: {
						type: :cont,
						dist: ["UniformDistribution"]
					},
					norm: {
						type: :cont,
						dist: ["NormalDistribution"]
					},
					t: {
						type: :cont,
						dist:["StudentDistribution"]
					},
					f: {
						type: :cont,
						dist:["FDistribution"]
					},
					chisq: {
						type: :cont,
						dist: ["ChiSquareDistribution"]
					},
					exp: {
						type: :cont,
						dist: ["ExponentialDistribution"]
					},
					cauchy: {
						type: :cont,
						dist: ["CauchyDistribution"]
					},
					discreteUniform: {
						type: :disc,
						dist: ["DiscreteUniformDistribution"]
					},
					bernoulli: {
						type: :disc,
						dist: ["BernoulliDistribution"]
					},
					binom: {
						type: :disc,
						dist: ["BinomialDistribution"]
					},
					birthday: {
						type: :disc,
						dist: ["BirthdayDistribution"]
					}
				}
			end
			@list=@@list
			if name
			  set(name,params)
			end
		end

		def set(dist,params)
			@name,@params=dist,params
			#p [@name,@list[@name]]
			@type=@list[@name][:type]
			instr="new "+@list[@name]["dist"].join(".")+"("+@params.join(',')+");"
			@distrib=%x{eval(#{instr})}
		end

    def minValue
			%x{#{@distrib}.minValue()}
		end

		def maxValue
			%x{#{@distrib}.maxValue()}
		end

		def regular?
			%x{#{@distrib}.regular()}
		end

		def mean
			%x{#{@distrib}.mean()}
		end

		def mode
			%x{#{@distrib}.mode()}
		end

		def maxPdf
			%x{#{@distrib}.maxDensity()}
		end

		def variance
			%x{#{@distrib}.variance()}
		end

		def stdDev
			%x{#{@distrib}.stdDev()}
		end

		def sample(n=1)
			z=[]
			1.upto(n) {|i| z << %x{#{@distrib}.simulate()}}
			return RVector.new(z)
		end

		def pdf?(x,ary=false)
			unless ary
				return %x{#{@distrib}.density(#{x});}
			else
				return RVector.new(x.to_a.map{|e| pdf?(e)})
			end
		end

		def pdf(x)
			pdf?(x,([Array,RVector].include? x.class))
		end

		def cdf?(x,ary=false)
			unless ary
				%x{#{@distrib}.CDF(#{x})}
			else
				return RVector.new(x.to_a.map{|e| cdf?(e)})
			end
		end

		def cdf(x)
			cdf?(x,([Array,RVector].include? x.class))
		end

		def quantile?(p,ary=false)
			unless ary
				%x{#{@distrib}.quantile(#{p})}
			else
				return RVector.new(p.to_a.map{|e| quantile?(e)})
			end
		end

		def quantile(p)
			quantile?(p,([Array,RVector].include? p.class))
		end

end

class RVector

  def initialize(vals)
    @y=%x{new CompleteData()}
    vals.each do |val|
      %x{#{@y}.setValue(#{val})};
    end
  end

	def to_a
		%x{#{@y}.getValues()}
	end

	def coerce(x)
			return [RVector.new(x.to_a),self]
	end

  def [](i)
    to_a[i-1]
  end

	def _recycle_(x)
		ary1,ary2=to_a,x.to_a
		s1,s2=ary1.size,ary2.size
		s=[s1,s2].max
		[s,(ary1*(s/s1).ceil)[0...s],(ary2*(s/s2).ceil)[0...s]]
	end

	def -@
		RVector.new to_a.map{|e| -e}
	end

	def +@
		self
	end

  def *(x)
		res=nil
    if x.is_a? RVector
			s,a1,a2=_recycle_(x)
      res=(0...s).map{|i| a1[i]*a2[i]}
    else
       res=to_a.each_with_index.map{|e,i| e*x}
    end
		RVector.new res
  end

	def /(x)
		res=nil
    if x.is_a? RVector
			s,a1,a2=_recycle_(x)
      res=(0...s).map{|i| a1[i]/a2[i]}
			# xx=x.to_a
      # res=to_a.each_with_index.map{|e,i| e/xx[i]}
    else
       res=to_a.each_with_index.map{|e,i| e/x}
    end
		RVector.new res
  end

	def +(x)
		res=nil
    if x.is_a? RVector
			s,a1,a2=_recycle_(x)
      res=(0...s).map{|i| a1[i]+a2[i]}
			# xx=x.to_a
      # res=to_a.each_with_index.map{|e,i| e+xx[i]}
    else
       res=to_a.each_with_index.map{|e,i| e+x}
    end
		RVector.new res
  end

	def -(x)
		res=nil
    if x.is_a? RVector
			s,a1,a2=_recycle_(x)
      res=(0...s).map{|i| a1[i]-a2[i]}
			# xx=x.to_a
      # res=to_a.each_with_index.map{|e,i| e-xx[i]}
    else
       res=to_a.each_with_index.map{|e,i| e-x}
    end
		RVector.new res
  end

	def **(x)
		res=nil
    if x.is_a? RVector
			s,a1,a2=_recycle_(x)
      res=(0...s).map{|i| a1[i]**a2[i]}
    else
       res=to_a.each_with_index.map{|e,i| e**x}
    end
		RVector.new res
  end

=begin
	## Aliases obsolete soon!
	alias add +
	alias substract -
	alias multiply *
	alias divide /
=end

	def to_Routput(width=60,round=8)
		tmp=to_a
		l=tmp.map{|e| e.round.to_s.length}.max
		p = (l > round ? 1 : round - l)
		ll = l + p +1
		ncol = (width / ll).to_i 
		nrow = ((size / ncol).floor + (size % ncol > 0 ? 1 : 0)).to_i
		lines = (0...nrow).map do |i|
			index="% #{(ncol*(nrow-1)).to_s.length+2}s" % "[#{(i*ncol)+1}]"
			line = ((i*ncol)..(i*ncol+ncol-1)).map{ |e| tmp[e] ? ("% #{ll}s" % ("%.#{p}f" %  tmp[e]) ) : "" }.join("  ")
			index + " " + line 
		end
		lines.join("\n")
	end

	def to_s
		to_a.to_s
	end

	def min
		to_a.min
	end

	def max
		to_a.max
	end

	def range
		tmp=to_a
		[tmp.min,tmp.max]
	end

	def diff
		tmp=to_a
		(1...size).map{|i| tmp[i]-tmp[i-1]}
	end

	def sum 
		to_a.inject :+
	end

	def prod 
		to_a.inject :*
	end

	def cumsum
		to_a.inject([]) { |x, y| x + [(x.last || 0) + y] }
	end

	def cumprod
		to_a.inject([]) { |x, y| x + [(x.last || 0) * y] }
	end

	def cummin
		to_a.inject([]) { |x, y| x + [[x.last || y,y].min] }
	end

	def cummax
		to_a.inject([]) { |x, y| x + [[x.last || y,y].max] }
	end

	def mean
		%x{#{@y}.mean()}
	end

	def var
	  %x{#{@y}.variance()}
	end

	def sd
	  %x{#{@y}.stdDev()}
	end

	def quantile(p)
	  %x{#{@y}.quantile(#{p})}
	end

	def size
		%x{#{@y}.size()}
	end

	def seMean
		#%x{#{@y}.stdDev()/Math.sqrt(#{@y}.size())}
		sd/Math.sqrt(size)
	end

	def squareFromMean
	  aryMean=mean
		return RVector.new to_a.map{|e| (e-aryMean)**2}
	end

	def seVar
	  return squareFromMean.seMean
	end

	def sqrt
		RVector.new to_a.map{|e| Math.sqrt(e)}
	end

end

class Numeric

=begin
	## Obsolete soon since coerce method of RVector makes the job!
	def add(x)
		if x.is_a? RVector
			x.add self
		else
			self + x
		end
	end

	def multiply(x)
		if x.is_a? RVector
			x.multiply self
		else
			self * x
		end
	end

	def substract(x)
    if x.is_a? RVector
      return RVector.new x.to_a.map{|e| self - e}
    else
       return self - x
    end
	end

	def divide(x)
		if x.is_a? RVector
      return RVector.new x.to_a.map{|e| self / e}
    else
       return self / x
    end
	end
=end

	def to_a
		[self]
	end

	def to_Routput
		(RVector.new [self]).to_Routput
	end

end

class Array
	def to_Routput
		(RVector.new self).to_Routput
	end
end

def c(*vals)
	vals=vals.map{|e|
		if e.is_a? RVector
			e.to_a
		else
			e
		end
	}
  y=RVector.new vals.flatten
  return y;
end

def runif(n,from=0,to=1)
  yy=Distribution.new("unif",[from, to])
  return yy.sample(n);
end

def dunif(x,from=0,to=1)
  yy=Distribution.new("unif",[from, to])
  return yy.pdf(x);
end

def qunif(p,from=0,to=1)
  yy=Distribution.new("unif",[from, to])
  return yy.quantile(p);
end

def punif(q,from=0,to=1)
  yy=Distribution.new("unif",[from, to])
  return yy.cdf(q);
end

def rnorm(n,mu=0,sigma=1)
  yy=Distribution.new("norm",[mu, sigma])
  return yy.sample(n);
end

def dnorm(x,mu=0,sigma=1)
  yy=Distribution.new("norm",[mu, sigma])
  return yy.pdf(x);
end

def qnorm(p,mu=0,sigma=1)
  yy=Distribution.new("norm",[mu, sigma])
  return yy.quantile(p);
end

def pnorm(q,mu=0,sigma=1)
  yy=Distribution.new("norm",[mu, sigma]);
  return yy.cdf(q);
end

def rt(n,df)
  yy=Distribution.new("t",[df])
  return yy.sample(n);
end

def dt(x,df)
  yy=Distribution.new("t",[df])
  return yy.pdf(x);
end

def qt(p,df)
  yy=Distribution.new("t",[df]);
  return yy.quantile(p);
end

def pt(q,df)
  yy=Distribution.new("t",[df]);
  return yy.cdf(q);
end

def rchisq(n,df)
  yy=Distribution.new("chisq",[df])
  return yy.sample(n);
end

def dchisq(x,df)
  yy=Distribution.new("chisq",[df])
  return yy.pdf(x);
end

def qchisq(p,df)
  yy=Distribution.new("chisq",[df]);
  return yy.quantile(p);
end

def pchisq(q,df)
  yy=Distribution.new("chisq",[df]);
  return yy.cdf(q);
end

def rf(n,df1,df2)
  yy=Distribution.new("f",[df1,df2])
  return yy.sample(n);
end

def df(x,df1,df2)
  yy=Distribution.new("f",[df1,df2])
  return yy.pdf(x);
end

def qf(p,df1,df2)
  yy=Distribution.new("f",[df1,df2]);
  return yy.quantile(p);
end

def pf(q,df1,df2)
  yy=Distribution.new("f",[df1,df2]);
  return yy.cdf(q);
end

def rep(yy,nn)
	return RVector.new (yy.to_a * nn)
end

def seq(from,to)
	return RVector.new(from.upto(to).to_a)
end

def length(yy)
  return yy.size;
end

def range(yy)
	return RVector.new yy.range
end

def diff(yy)
	return RVector.new yy.diff
end

def sum(yy)
	yy.sum
end

def prod(yy)
	yy.prod
end

def cumsum(yy)
	return RVector.new yy.cumsum
end

def cumprod(yy)
	return RVector.new yy.cumprod
end

def cummin(yy)
	return RVector.new yy.cummin
end

def cummax(yy)
	return RVector.new yy.cummax
end

def mean(yy)
  yy.mean
end

def var(yy)
  yy.var
end

def varPop(yy)
	mean(yy**2) - mean(yy)**2
end

def sd(yy)
  yy.sd
end

def cov(yy,yy2)
	(mean(yy * yy2) - mean(yy)*mean(yy2))*yy.size/(yy.size-1)
end

def corr(yy,yy2)
	cov(yy,yy2)/sqrt(var(yy)*var(yy2))
end

def sqrt(x)
	(x.is_a? RVector) ? x.sqrt : Math.sqrt(x)
end

def quantile(yy,p)
	yy.quantile(p)
end

def seMean(yy)
  yy.seMean
end

def seVar(yy)
  yy.seVar
end

def seDMean(yy1,yy2,rho=1.0)
  Math.sqrt(yy1.var/yy1.size + rho**2 * yy2.var/yy2.size)
end

def seDMeanG(yy1,yy2)
	n1=yy1.size
	n2=yy2.size
	Math.sqrt(((n1 - 1) * yy1.var + (n2 - 1) * yy2.var)/(n1 + n2 - 2) * (1/n1 + 1/n2))
end

def seDVar(yy1,yy2,rho=1.0)
	yy1var=yy1.squareFromMean.var
	yy2var=yy2.squareFromMean.var
	Math.sqrt(yy1var/yy1.size + rho**2 * yy2var/yy2.size)
end

def seRMean(yy1,yy2,r0=nil)
	r0 ||= yy1.mean/yy2.mean
  Math.sqrt(yy1.var/yy1.size + r0**2 * yy2.var/yy2.size)/yy2.mean.abs
end

def seRVar(yy1,yy2,r0=nil)
	r0 ||= yy1.var/yy2.var
	yy1var=yy1.squareFromMean.var
	yy2var=yy2.squareFromMean.var
	Math.sqrt(yy1var/yy1.size + r0**2 * yy2var/yy2.size)/yy2.var
end

module QuizzTest

	def QuizzTest.score_value(value,expected,score=[1,0])
		(value == expected ? score[0] : score[1])
	end

	def QuizzTest.score_expression(expression,expected,score=[1,0])
		(expression.gsub(" ","") == expected) ? score[0] : score[1]
	end

	def QuizzTest.score_expression_words(expression,expected,score=[1,0])
		words=expression.split(/[\(\)]/).map{|e| e.strip}.select{|e| !e.empty?}
		expected_words=expected.split(/[\(\)]/).map{|e| e.strip}.select{|e| !e.empty?}
		n = expected_words.length + words.length
		[n - ((words - expected_words).length + (expected_words - words).length),n]  
	end

	def QuizzTest.score_expression_contains(expression,expected_patterns,score=[1,0])
		expr = expression.gsub(" ","") 
		[expected_patterns.map{|pattern| (expr.include? pattern) ? score[0] : score[1]}.sum,expected_patterns.length]
	end

	def QuizzText.parse(rule)
		expr,mode="",""
		rule.split("\n").map{|line|
			if line.strip =~/^expr\: (.*)/
				expr=$1.strip
			elsif line.strip =~/^mode\: (.*)/
				mode=$1.strip
			end
			$1
		}
	end
end