import cors from "cors";
import express from "express";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { WebSocketServer, WebSocket } from "ws";


const PORT =
  Number(process.env.SCRAPER_PORT || 8788);


const VIEWPORT = {
  width: 1280,
  height: 800
};


const USER_DATA_DIR =
  "/app/browser-data";


const LOG_DIR =
  resolve(
    process.env.SCRAPER_LOG_DIR || "logs"
  );


mkdirSync(
  LOG_DIR,
  {
    recursive:true
  }
);



const activityLog =
  createWriteStream(
    resolve(LOG_DIR,"scraper.log"),
    {
      flags:"a"
    }
  );


const errorLog =
  createWriteStream(
    resolve(LOG_DIR,"error.log"),
    {
      flags:"a"
    }
  );





function errorDetails(error){

  return {

    name:
      error?.name || "Error",

    message:
      error?.message || String(error),

    stack:
      error?.stack || ""

  };

}






function safeUrl(value){

  try{

    const url =
      new URL(value);

    return (
      url.origin +
      url.pathname
    );

  }
  catch{

    return String(value || "");

  }

}






function log(
  level,
  event,
  details={}
){


  const entry = {

    timestamp:
      new Date().toISOString(),

    level,

    event,

    ...details

  };



  const line =
    JSON.stringify(entry);



  activityLog.write(
    line + "\n"
  );



  if(level==="error"){

    errorLog.write(
      line + "\n"
    );

  }



  const output =
    `[${entry.timestamp}] ${event}`;



  if(level==="error")
    console.error(
      output,
      details
    );
  else if(level==="warn")
    console.warn(
      output,
      details
    );
  else
    console.log(
      output,
      details
    );


}






/*
 CONNECTION RATE LIMIT

 Allows browser refresh/reconnects

*/


const RATE_LIMIT = {

  max:20,

  window:60000

};



const rateStore =
  new Map();





function checkRate(ip){


  const now =
    Date.now();



  let data =
    rateStore.get(ip);



  if(
    !data ||
    now > data.reset
  ){

    data = {

      count:0,

      reset:
        now + RATE_LIMIT.window

    };

  }



  data.count++;



  rateStore.set(
    ip,
    data
  );



  return (
    data.count <=
    RATE_LIMIT.max
  );


}







const app =
  express();



app.use(
  cors()
);




app.get(
  "/",
  (_req,res)=>{

    res.send(
      "Vision scraper running"
    );

  }
);




app.get(
  "/health",
  (_req,res)=>{

    res.json(
      {
        ok:true
      }
    );

  }
);






const server =
  createServer(app);



const sockets =
  new WebSocketServer(
    {
      server
    }
  );







const send =
(socket,data)=>{


  if(
    socket.readyState ===
    WebSocket.OPEN
  ){

    socket.send(
      JSON.stringify(data)
    );

  }


};







function cleanUrl(value){


  try{


    const url =
      new URL(value);



    if(
      ![
        "http:",
        "https:"
      ].includes(url.protocol)
    ){

      return null;

    }



    return url.href;


  }
  catch{

    return null;

  }

}







function dedupe(items){


  const seen =
    new Set();



  return items.filter(
    item=>{


      if(
        !item?.url ||
        seen.has(item.url)
      ){

        return false;

      }



      seen.add(
        item.url
      );



      return true;


    }
  );


}
async function extractShopifyDirect(url){

  try{


    const parsed =
      new URL(url);



    let endpoint;



    if(
      parsed.pathname.includes("/collections/")
    ){

      const parts =
        parsed.pathname
        .split("/")
        .filter(Boolean);


      const collection =
        parts[1];


      endpoint =
        `${parsed.origin}/collections/${collection}/products.json?limit=100`;


    }else{


      endpoint =
        `${parsed.origin}/products.json?limit=100`;


    }




    let response;



    for(
      let attempt=1;
      attempt<=3;
      attempt++
    ){



      response =
        await fetch(
          endpoint,
          {

            headers:{

              "Accept":
                "application/json",

              "User-Agent":
                "Mozilla/5.0",

              "Cache-Control":
                "no-cache",

              "Referer":
                parsed.origin

            }

          }
        )
        .catch(
          ()=>null
        );




      if(
        response &&
        response.ok
      ){

        break;

      }



      log(
        "warn",
        "shopify_retry",
        {

          attempt,

          status:
            response?.status || 0

        }
      );



      await new Promise(
        r =>
          setTimeout(
            r,
            attempt * 2000
          )
      );


    }





    if(
      !response ||
      !response.ok
    ){


      log(
        "warn",
        "shopify_json_failed",
        {
          endpoint
        }
      );


      return null;


    }





    const data =
      await response.json();



    const products =
      data.products || [];




    const assets =
      products.flatMap(
        product =>


          (product.images || [])
          .map(
            image=>({


              url:
                image.src,


              type:
                "image",



              source:
                "shopify-json",



              alt:
                product.title,



              width:
                image.width || 0,



              height:
                image.height || 0


            })

          )


      );






    return {


      title:
        products[0]?.title || "",



      assets:
        dedupe(assets)
        .slice(
          0,
          300
        )


    };





  }catch(error){



    log(
      "error",
      "shopify_direct_failed",
      {

        error:
          errorDetails(error)

      }
    );



    return null;


  }


}









async function extractShopify(page){


  try{



    const current =
      new URL(
        page.url()
      );



    const match =
      current.pathname.match(
        /\/products\/([^\/?#]+)/
      );



    if(!match){

      return null;

    }




    const endpoint =
      `${current.origin}/products/${match[1]}.js`;





    const response =
      await page.request.get(
        endpoint,
        {
          timeout:8000
        }
      );



    if(
      !response.ok()
    ){

      return null;

    }




    const product =
      await response.json();





    const assets =
      (product.images || [])
      .map(
        image=>({


          url:
            typeof image==="string"
            ? image
            : image.src,


          type:
            "image",


          source:
            "shopify",


          alt:
            product.title


        })

      );




    return {

      title:
        product.title,


      assets:
        dedupe(assets)

    };



  }catch{


    return null;


  }


}


async function extractPageMedia(page){


  try{


    return await page.evaluate(
    ()=>{


      const absolute =
        value=>{


          try{


            return new URL(
              value,
              location.href
            ).href;


          }catch{


            return "";

          }


        };





      const assets =
        [...document.images]
        .map(
          img=>({


            url:
              absolute(
                img.currentSrc ||
                img.src
              ),


            type:
              "image",


            source:
              "browser",


            alt:
              img.alt || "",


            width:
              img.naturalWidth,


            height:
              img.naturalHeight



          })

        )
        .filter(
          item=>

            item.url &&

            item.width >= 300 &&

            item.height >= 300

        )
        .slice(
          0,
          100
        );




      return {


        title:
          document.title,



        assets


      };



    });



  }catch{


    return {

      title:"",

      assets:[]

    };


  }


}









async function extractAll(page,url){


  const shopify =
    await extractShopifyDirect(
      url
    );



  if(
    shopify?.assets?.length
  ){

    return shopify;

  }




  const product =
    await extractShopify(
      page
    );



  if(
    product?.assets?.length
  ){

    return product;

  }




  return await extractPageMedia(
    page
  );


}
sockets.on(
"connection",
(socket,request)=>{


const ip =
  request.socket.remoteAddress ||
  "unknown";



if(
  !checkRate(ip)
){

  send(
    socket,
    {
      type:"error",
      message:"Too many requests. Please wait."
    }
  );


  socket.close();

  return;

}




const sessionId =
  randomUUID();



let context = null;
let browser = null;
let page = null;
let frameTimer = null;



const started =
  Date.now();



log(
  "info",
  "session_connected",
  {
    sessionId,
    ip
  }
);







async function publishFrame(){


  if(
    !page ||
    page.isClosed()
  ){

    return;

  }



  try{


    const screenshot =
      await page.screenshot(
      {

        type:"jpeg",

        quality:60

      });



    send(
      socket,
      {

        type:"frame",

        data:
          screenshot.toString("base64"),


        width:
          VIEWPORT.width,


        height:
          VIEWPORT.height,


        url:
          page.url()


      }
    );



    log(
      "info",
      "frame_sent",
      {
        sessionId
      }
    );



  }catch(error){


    log(
      "warn",
      "frame_failed",
      {
        sessionId,
        error:
          errorDetails(error)
      }
    );


  }


}









async function inspect(){


 if(
   !page ||
   page.isClosed()
 ){

   return;

 }



 try{


  const result =
    await extractAll(
      page,
      page.url()
    );



  const assets =
    dedupe(
      result.assets || []
    )
    .slice(
      0,
      300
    );



  send(
    socket,
    {

      type:"assets",

      count:
        assets.length,


      assets,


      product:
      {

        title:
          result.title || "",


        url:
          page.url()

      }

    }
  );



  log(
    "info",
    "media_extracted",
    {

      sessionId,

      assets:
        assets.length

    }
  );



 }catch(error){


  log(
    "error",
    "inspect_failed",
    {
      sessionId,
      error:
        errorDetails(error)
    }
  );


 }


}









socket.on(
"message",
async raw=>{


try{


const message =
 JSON.parse(
   raw.toString()
 );





if(
 message.type === "start"
){



 const destination =
   cleanUrl(
     message.url
   );



 if(!destination){


   send(
    socket,
    {
     type:"error",
     message:"Invalid URL"
    }
   );


   return;


 }




 log(
  "info",
  "start_requested",
  {

    sessionId,

    url:
      safeUrl(destination)

  }
 );





const direct =
 await extractShopifyDirect(
   destination
 );



if(
 direct?.assets?.length
){


 send(
  socket,
  {

    type:"assets",

    count:
      direct.assets.length,


    assets:
      direct.assets,


    product:
    {

      title:
        direct.title,


      url:
        destination

    }

  }
 );



 log(
  "info",
  "shopify_json_extracted",
  {

    sessionId,

    assets:
      direct.assets.length

  }
 );


}








context =
 await chromium.launchPersistentContext(
 USER_DATA_DIR,
 {

  headless:true,


  viewport:
    VIEWPORT,


  locale:
    "en-US",


  timezoneId:
    "America/New_York",



  args:
  [

   "--no-sandbox",

   "--disable-dev-shm-usage",

   "--disable-blink-features=AutomationControlled"

  ]

 }
);





browser =
 context.browser();



page =
 await context.newPage();





page.on(
"crash",
()=>{


 log(
  "error",
  "page_crashed",
  {
    sessionId
  }
 );


});





await page.goto(
 destination,
 {

  waitUntil:
    "domcontentloaded",

  timeout:
    45000

 }
);






await page.waitForTimeout(
2000
);




await publishFrame();



await inspect();





frameTimer =
 setInterval(
   publishFrame,
   1500
 );




send(
 socket,
 {

  type:"status",

  status:"live",

  message:
    "Browser connected"

 }
);





log(
 "info",
 "browser_ready",
 {

  sessionId,

  url:
    safeUrl(page.url()),


  durationMs:
    Date.now()-started

 }
);



}








if(
 message.type==="click" &&
 page
){


 await page.mouse.click(
   Number(message.x),
   Number(message.y)
 );


 await page.waitForTimeout(
  1000
 );


 await publishFrame();

 await inspect();


}







if(
 message.type==="scroll" &&
 page
){


 await page.mouse.wheel(
   0,
   Number(message.deltaY)
 );


 await page.waitForTimeout(
   500
 );


 await publishFrame();

}



if(
 message.type==="reload" &&
 page
){


 await page.reload(
 {

  waitUntil:
    "domcontentloaded"

 }
 );


 await publishFrame();

 await inspect();


}



}catch(error){


log(
 "error",
 "message_failed",
 {

  sessionId,

  error:
    errorDetails(error)

 }
);



send(
 socket,
 {

  type:"error",

  message:
    error.message

 }
);



}



});








socket.on(
"close",
async()=>{


 clearInterval(
   frameTimer
 );



 await context
 ?.close()
 .catch(()=>{});



 await browser
 ?.close()
 .catch(()=>{});



 log(
  "info",
  "session_closed",
  {

   sessionId,

   durationMs:
     Date.now()-started

  }
 );


});


});








server.listen(
PORT,
()=>{


log(
"info",
"server_started",
{

 port:
   PORT,


 activityLog:
   resolve(
     LOG_DIR,
     "scraper.log"
   ),


 errorLog:
   resolve(
     LOG_DIR,
     "error.log"
   )

}
);


});
