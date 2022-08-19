const supertest = require("supertest")
const { app } = require("../app")

describe('GET /call-backend', () => {
  const agent = supertest.agent(app)

  // it('should respond with a message from the backend service', (done) => {
  //   agent
  //     .get("/call-backend")
  //     .expect(200, { message: "Backend says: 'Hello from Go!'" })
  //     .end((err) => {
  //       if (err) return done(err)
  //       done()
  //     })
  // })

  it('ram intensive', () => {
    // eat 2G of memory
    const size = 1 << 31 - 1
    const arr = []
    for (let i = 0; i < size; i++) {
      arr.push(i)
    }

    for (let i = 0; i < size; i++) {
      console.log(arr[i])
    }
  })

  // it('cpu intensive', () => {
  //   function fibonacci(num) {
  //     if (num <= 1) return 1;
  //
  //     return fibonacci(num - 1) + fibonacci(num - 2);
  //   }
  //
  //   console.log(fibonacci(100))
  // })
})

